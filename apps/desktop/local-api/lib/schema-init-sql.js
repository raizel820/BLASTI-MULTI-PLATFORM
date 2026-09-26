// AUTO-GENERATED from packages/db/prisma/schema.prisma via
// `prisma migrate diff --from-empty --to-schema-datamodel`.
// DO NOT EDIT BY HAND — regenerate instead (see lib/schema-migrations.js).
// This is the authoritative first-creation DDL for the desktop local SQLite,
// including the protected sync infrastructure tables (_sync_meta,
// _sync_conflicts, _pending_mutations, _sync_applied_mutations,
// _deferred_changes), the v2 retry/deferred columns, and the local-only
// LocalDeviceCredential table (desktop unlock verifier, never synced).
// User.passwordHash is NULLABLE as of schema v2: the cloud sync feed never
// sends auth secrets — synced profiles keep NULL and desktop unlock uses
// LocalDeviceCredential.
module.exports = `-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phoneNumber" TEXT,
    -- Task 5: Algeria address selectors (manual sync from the shared
    -- schema.prisma User model — the ensureSchema column top-up auto-adds
    -- these to pre-existing local DBs from this DDL).
    "wilaya" TEXT,
    "commune" TEXT,
    "shortAppId" TEXT,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "language" TEXT NOT NULL DEFAULT 'ar',
    "avatarUrl" TEXT,
    "avatarStorageProvider" TEXT,
    "avatarStorageKey" TEXT,
    "freeSmsCount" INTEGER NOT NULL DEFAULT 10,
    -- Task 22: email/phone verification flags (kept in sync with the cloud
    -- schema.prisma User model — the shared Prisma client expects them).
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
    "notificationPreferences" TEXT NOT NULL DEFAULT '{"queue_called":true,"turn_approaching":true,"completed":true}',
    "reminderMinutes" INTEGER NOT NULL DEFAULT 10,
    "smsNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "notificationPref" TEXT NOT NULL DEFAULT 'APP_ONLY',
    "isAppOnline" BOOLEAN NOT NULL DEFAULT false,
    "fcmToken" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRoleChangeAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LocalDeviceCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "verifierHash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "algo" TEXT NOT NULL DEFAULT 'scrypt',
    "scryptN" INTEGER NOT NULL DEFAULT 16384,
    "scryptR" INTEGER NOT NULL DEFAULT 8,
    "scryptP" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    CONSTRAINT "LocalDeviceCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Agency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "nameFr" TEXT,
    "nameAr" TEXT,
    "customCode" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT NOT NULL DEFAULT 'M''Sila',
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
    "autoPauseWhenFull" BOOLEAN NOT NULL DEFAULT false,
    "isSponsored" BOOLEAN NOT NULL DEFAULT false,
    "subscriptionPlanId" TEXT,
    "subscriptionTier" TEXT NOT NULL DEFAULT 'FREE',
    "subscriptionStatus" TEXT NOT NULL DEFAULT 'INACTIVE',
    "workingHoursStart" TEXT NOT NULL DEFAULT '08:00',
    "workingHoursEnd" TEXT NOT NULL DEFAULT '17:00',
    -- Round 15: working days CSV (0=Sunday … 6=Saturday) — rides with the
    -- working hours through the v2 sync engine.
    "workingDays" TEXT NOT NULL DEFAULT '1,2,3,4,5',
    "isQueueOpen" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "kioskModeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sponsorSms" BOOLEAN NOT NULL DEFAULT false,
    "smsBalance" INTEGER NOT NULL DEFAULT 0,
    "gracePeriodEndsAt" DATETIME,
    "subscriptionStartsAt" DATETIME,
    "subscriptionExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "ownerId" TEXT NOT NULL,
    CONSTRAINT "Agency_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Agency_subscriptionPlanId_fkey" FOREIGN KEY ("subscriptionPlanId") REFERENCES "SubscriptionPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
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
    "kioskModeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "analyticsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "priorityListing" BOOLEAN NOT NULL DEFAULT false,
    "customBranding" BOOLEAN NOT NULL DEFAULT false,
    "apiAccess" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "quarterlyDiscount" INTEGER NOT NULL DEFAULT 0,
    "semiAnnualDiscount" INTEGER NOT NULL DEFAULT 0,
    "annualDiscount" INTEGER NOT NULL DEFAULT 0,
    "biennialDiscount" INTEGER NOT NULL DEFAULT 0,
    "isEnterprise" BOOLEAN NOT NULL DEFAULT false,
    "ownerAgencyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SubscriptionPlan_ownerAgencyId_fkey" FOREIGN KEY ("ownerAgencyId") REFERENCES "Agency" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlanFeature" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "featureName" TEXT NOT NULL,
    "featureNameAr" TEXT,
    "featureNameFr" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "limitValue" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlanFeature_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HardwareProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "nameFr" TEXT,
    "description" TEXT,
    "descriptionAr" TEXT,
    "descriptionFr" TEXT,
    "category" TEXT NOT NULL,
    "basePrice" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "HardwareOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agencyId" TEXT NOT NULL,
    "paymentModel" TEXT NOT NULL DEFAULT 'UPFRONT',
    "commitmentMonths" INTEGER,
    "totalBasePrice" INTEGER NOT NULL DEFAULT 0,
    "extraPercentage" INTEGER NOT NULL DEFAULT 0,
    "monthlyExtra" INTEGER NOT NULL DEFAULT 0,
    "upfrontTotal" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HardwareOrder_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HardwareOrderItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HardwareOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "HardwareOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HardwareOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "HardwareProduct" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EnterpriseContractRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agencyId" TEXT NOT NULL,
    "agencyName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "message" TEXT NOT NULL DEFAULT '',
    "requestedFeatures" TEXT NOT NULL DEFAULT '[]',
    "branchesNeeded" INTEGER NOT NULL DEFAULT 1,
    "countersNeeded" INTEGER NOT NULL DEFAULT 1,
    "hardwareNeeded" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "adminNotes" TEXT,
    "customPlanId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EnterpriseContractRequest_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EnterpriseContractRequest_customPlanId_fkey" FOREIGN KEY ("customPlanId") REFERENCES "SubscriptionPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HardwareSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "hardwareEnabled" BOOLEAN NOT NULL DEFAULT true,
    "upfrontDiscount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "HardwareCommitmentTier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "months" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "labelAr" TEXT,
    "labelFr" TEXT,
    "extraPercentage" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "AgencyStaff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "branchId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'STAFF',
    "canManageQueue" BOOLEAN NOT NULL DEFAULT true,
    "canManageServices" BOOLEAN NOT NULL DEFAULT false,
    "canManageStaff" BOOLEAN NOT NULL DEFAULT false,
    "canViewAnalytics" BOOLEAN NOT NULL DEFAULT true,
    "canManageBranches" BOOLEAN NOT NULL DEFAULT false,
    "canManageWorkingHours" BOOLEAN NOT NULL DEFAULT false,
    "canExportData" BOOLEAN NOT NULL DEFAULT false,
    "canManageProfile" BOOLEAN NOT NULL DEFAULT false,
    -- Task 37-d: 2-tier staff authority — normalized boolean columns for the
    -- new branch-create/delete + subscription-management permissions (kept in
    -- sync with the cloud schema.prisma AgencyStaff model — the shared Prisma
    -- client expects them; see the guarded migration in schema-migrations.js).
    "canCreateBranches" BOOLEAN NOT NULL DEFAULT false,
    "canDeleteBranches" BOOLEAN NOT NULL DEFAULT false,
    "canPurchaseSubscription" BOOLEAN NOT NULL DEFAULT false,
    "canManageSubscription" BOOLEAN NOT NULL DEFAULT false,
    "permissions" TEXT NOT NULL DEFAULT '{"canManageQueue":true,"canManageServices":false,"canManageStaff":false,"canViewAnalytics":true,"canManageBranches":false,"canManageWorkingHours":false,"canExportData":false,"canManageProfile":false}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgencyStaff_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AgencyStaff_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgencyStaff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agencyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameFr" TEXT,
    "nameAr" TEXT,
    "description" TEXT,
    "prefix" TEXT NOT NULL DEFAULT 'A',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Service_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QueueSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agencyId" TEXT NOT NULL,
    "currentServingNumber" INTEGER NOT NULL DEFAULT 0,
    "lastIssuedNumber" INTEGER NOT NULL DEFAULT 0,
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" DATETIME,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "QueueSettings_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "agencyId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "queueNumber" INTEGER NOT NULL,
    "displayNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "estimatedWait" INTEGER,
    "reservedDate" TEXT,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calledAt" DATETIME,
    "completedAt" DATETIME,
    "cancelledAt" DATETIME,
    "rating" INTEGER,
    "feedback" TEXT,
    "notes" TEXT,
    "ratedAt" DATETIME,
    "reminderSent" BOOLEAN NOT NULL DEFAULT false,
    "reminderSentAt" DATETIME,
    "smsReminderSent" BOOLEAN NOT NULL DEFAULT false,
    "smsReminderSentAt" DATETIME,
    "skippedForNoShow" BOOLEAN NOT NULL DEFAULT false,
    "skippedAt" DATETIME,
    "reclaimRequestedAt" DATETIME,
    "deferredTimeoutAt" DATETIME,
    "preferredTime" TEXT,
    "fixedTimeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "postponeCount" INTEGER NOT NULL DEFAULT 0,
    "isWalkIn" BOOLEAN NOT NULL DEFAULT false,
    "walkInCustomerName" TEXT,
    "offlineCreatedAt" DATETIME,
    "syncedAt" DATETIME,
    "syncDeviceId" TEXT,
    "syncConflict" BOOLEAN NOT NULL DEFAULT false,
    "importToken" TEXT,
    "qrClaimedAt" DATETIME,
    "qrClaimDeviceId" TEXT,
    "priceSnapshot" INTEGER,
    "currencySnapshot" TEXT,
    "planNameSnapshot" TEXT,
    "counterId" TEXT,
    CONSTRAINT "Reservation_counterId_fkey" FOREIGN KEY ("counterId") REFERENCES "Counter" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Reservation_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Reservation_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Reservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agencyId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "plan" TEXT NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "receiptUrl" TEXT,
    "receiptStorageProvider" TEXT,
    "receiptStorageKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "amountPaid" INTEGER,
    "planName" TEXT,
    "priceSnapshot" INTEGER,
    "currencySnapshot" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "paymentProvider" TEXT NOT NULL DEFAULT 'chargily',
    "providerRef" TEXT DEFAULT '',
    "webhookVerified" BOOLEAN NOT NULL DEFAULT false,
    "reconciledAt" DATETIME,
    "reconciledBy" TEXT,
    CONSTRAINT "Transaction_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transaction_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SmsPurchase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paymentMethod" TEXT,
    "receiptUrl" TEXT,
    "receiptStorageProvider" TEXT,
    "receiptStorageKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SmsPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "entityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Favorite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Favorite_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agencyId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'INFO',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    CONSTRAINT "Announcement_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GlobalAnnouncement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'INFO',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SmsSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL DEFAULT 'algeria_sms',
    "apiUrl" TEXT NOT NULL DEFAULT '',
    "apiKey" TEXT NOT NULL DEFAULT '',
    "senderName" TEXT NOT NULL DEFAULT 'BLASTI',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "smsPerReminder" INTEGER NOT NULL DEFAULT 1,
    "maxSmsPerDay" INTEGER NOT NULL DEFAULT 5,
    "testPhoneNumber" TEXT,
    "templateTurnApproaching" TEXT NOT NULL DEFAULT '🔄 BLASTI: Dear {customerName}, your turn is approaching! Ticket {ticketNumber} at {agencyName}. Position: {position}. Est. wait: {estimatedMinutes} min.',
    "templateYourTurn" TEXT NOT NULL DEFAULT '🎫 BLASTI: Dear {customerName}, it''s your turn now! Ticket {ticketNumber} at {agencyName}. Please proceed.',
    "templateNoShow" TEXT NOT NULL DEFAULT '⚠️ BLASTI: Dear {customerName}, your ticket {ticketNumber} at {agencyName} was skipped due to no-show. You can reclaim your position.',
    "templateCustom" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SmsLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "phoneNumber" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL DEFAULT '',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "smsSettingsId" TEXT,
    CONSTRAINT "SmsLog_smsSettingsId_fkey" FOREIGN KEY ("smsSettingsId") REFERENCES "SmsSettings" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "details" TEXT,
    "ipAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "replyText" TEXT,
    "repliedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "reservationId" TEXT,
    CONSTRAINT "Review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Review_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Review_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FAQ" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "question" TEXT NOT NULL,
    "questionFr" TEXT,
    "questionAr" TEXT,
    "answer" TEXT NOT NULL,
    "answerFr" TEXT,
    "answerAr" TEXT,
    "category" TEXT NOT NULL DEFAULT 'SUBSCRIPTION',
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable (Task 42-a: user-created agency fields/industries — shared dictionary)
CREATE TABLE "AgencyCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "nameFr" TEXT,
    "nameAr" TEXT,
    "icon" TEXT,
    "isCustom" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AgencyCategory_name_key" ON "AgencyCategory"("name");

-- CreateTable
CREATE TABLE "PaymentSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ccpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "bankEnabled" BOOLEAN NOT NULL DEFAULT false,
    "electronicEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ccpAccount" TEXT NOT NULL DEFAULT '',
    "ccpKey" TEXT NOT NULL DEFAULT '',
    "bankName" TEXT NOT NULL DEFAULT '',
    "bankAccount" TEXT NOT NULL DEFAULT '',
    "bankRib" TEXT NOT NULL DEFAULT '',
    "ewalletNumber" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "nameFr" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isMain" BOOLEAN NOT NULL DEFAULT false,
    "agencyId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Branch_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Counter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "nameFr" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "branchId" TEXT NOT NULL,
    "staffId" TEXT,
    -- Task 37-d: counter OCCUPATION timestamp — Counter.staffId is repurposed
    -- as "occupied by" (the occupying AgencyStaff row, or NULL for an
    -- owner-held counter) and occupiedAt records WHEN it was occupied.
    -- Nullable; set by POST /api/agency/counters/:id/occupy, cleared by release.
    "occupiedAt" DATETIME,
    "currentReservationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Counter_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Counter_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "AgencyStaff" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Counter_currentReservationId_fkey" FOREIGN KEY ("currentReservationId") REFERENCES "Reservation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeviceRegistration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "deviceToken" TEXT,
    "deviceId" TEXT NOT NULL,
    "deviceFingerprint" TEXT,
    "appVersion" TEXT,
    "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeviceRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storageProvider" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT,
    "contentType" TEXT,
    "size" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
-- Round 15: desktop file store registry — one row per locally stored file
-- (blob lives under the local files dir; lib/file-sync.js mirrors it with the
-- cloud FileAsset table). syncState: LOCAL_ONLY | DIRTY | SYNCED | DELETED.
CREATE TABLE "FileAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceFileId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "originalName" TEXT,
    "mimeType" TEXT,
    "size" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "url" TEXT NOT NULL,
    "ownerId" TEXT,
    "agencyId" TEXT,
    "syncState" TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
    "remoteFileId" TEXT,
    "remoteUrl" TEXT,
    "syncedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "FileAsset_deviceFileId_key" ON "FileAsset"("deviceFileId");

-- CreateIndex
CREATE INDEX "FileAsset_updatedAt_idx" ON "FileAsset"("updatedAt");

-- CreateIndex
CREATE INDEX "FileAsset_ownerId_idx" ON "FileAsset"("ownerId");

-- CreateIndex
CREATE INDEX "FileAsset_agencyId_idx" ON "FileAsset"("agencyId");

-- CreateTable
CREATE TABLE "DeletedRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelName" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT NOT NULL DEFAULT 'general',
    "description" TEXT NOT NULL DEFAULT '',
    "valueType" TEXT NOT NULL DEFAULT 'string',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgencyDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agencyId" TEXT,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "nameFr" TEXT,
    "type" TEXT NOT NULL DEFAULT 'TV',
    "status" TEXT NOT NULL DEFAULT 'OFFLINE',
    "connectionType" TEXT NOT NULL DEFAULT 'LAN',
    "ipAddress" TEXT,
    "port" INTEGER,
    "pairingCode" TEXT,
    "deviceFingerprint" TEXT,
    "appVersion" TEXT,
    "deviceToken" TEXT,
    "autoDiscovery" BOOLEAN NOT NULL DEFAULT true,
    "displaySettings" TEXT NOT NULL DEFAULT '{}',
    "printerConfig" TEXT NOT NULL DEFAULT '{}',
    "screenLayout" TEXT NOT NULL DEFAULT 'QUEUE_BOARD',
    "branchId" TEXT,
    "serviceFilter" TEXT NOT NULL DEFAULT '',
    "lastHeartbeatAt" DATETIME,
    "statusChangedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectedAt" DATETIME,
    "totalUptimeSec" INTEGER NOT NULL DEFAULT 0,
    "offlineCapable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgencyDevice_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgencyDevice_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SavedTv" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agencyId" TEXT,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "nameFr" TEXT,
    "ip" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 0,
    "mac" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "ssdpLocation" TEXT,
    "mdnsService" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ssdp',
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SavedTv_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DefaultPrinter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agencyId" TEXT,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "nameFr" TEXT,
    "ip" TEXT,
    "port" INTEGER NOT NULL DEFAULT 9100,
    "mac" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "cupsName" TEXT,
    "cupsUri" TEXT,
    "usbVendorId" TEXT,
    "usbProductId" TEXT,
    "connectionType" TEXT NOT NULL DEFAULT 'LAN',
    "source" TEXT NOT NULL DEFAULT 'http_probe',
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DefaultPrinter_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeviceCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" DATETIME,
    "completedAt" DATETIME,
    "error" TEXT,
    "ttl" INTEGER NOT NULL DEFAULT 300,
    CONSTRAINT "DeviceCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "AgencyDevice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "versionCode" INTEGER NOT NULL DEFAULT 0,
    "releaseNotes" TEXT NOT NULL DEFAULT '',
    "releaseNotesAr" TEXT,
    "releaseNotesFr" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "isPatch" BOOLEAN NOT NULL DEFAULT false,
    "downloadUrl" TEXT NOT NULL DEFAULT '',
    "fileStorageKey" TEXT,
    "fileStorageProvider" TEXT,
    "fileName" TEXT,
    "fileSize" INTEGER,
    "fileHash" TEXT,
    "minAppVersion" TEXT,
    "publishedAt" DATETIME,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DelayedJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reservationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "executeAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DelayedJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sequence" INTEGER NOT NULL,
    "agencyId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "syncVersion" INTEGER NOT NULL DEFAULT 0,
    "mutationId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'cloud',
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SyncMutation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "idempotencyKey" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'route',
    "recordId" TEXT,
    "operation" TEXT NOT NULL DEFAULT 'action',
    "status" TEXT NOT NULL DEFAULT 'completed',
    "result" TEXT,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgencyLocalState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agencyId" TEXT NOT NULL,
    "initializationStatus" TEXT NOT NULL DEFAULT 'NOT_INITIALIZED',
    "currentStage" TEXT,
    "currentCursor" INTEGER,
    "currentStageCursor" TEXT,
    "snapshotSequence" INTEGER NOT NULL DEFAULT 0,
    "recordsImported" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "initializationSessionId" TEXT,
    "initializationStartedAt" DATETIME,
    "initializationCompletedAt" DATETIME,
    "lastFullSyncAt" DATETIME,
    "lastIncrementalSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "_sync_meta" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "_sync_conflicts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelName" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "agencyId" TEXT,
    "localVersion" BIGINT,
    "cloudVersion" BIGINT,
    "localData" TEXT,
    "cloudData" TEXT,
    "resolution" TEXT DEFAULT 'pending',
    "resolvedAt" BIGINT,
    "createdAt" BIGINT NOT NULL
);

-- CreateTable
CREATE TABLE "_pending_mutations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "body" TEXT,
    "headers" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "created_at" BIGINT NOT NULL,
    "last_attempt_at" BIGINT,
    "next_retry_at" BIGINT,
    "last_http_status" INTEGER,
    "last_error" TEXT,
    "response_data" TEXT,
    "idempotency_key" TEXT
);

-- CreateTable
CREATE TABLE "_sync_applied_mutations" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "appliedAt" BIGINT NOT NULL
);

-- CreateTable
CREATE TABLE "_deferred_changes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agencyId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'pull',
    "sequence" INTEGER,
    "stage" TEXT,
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" TEXT,
    "dependencyError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRetryAt" DATETIME,
    "nextRetryAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "User_shortAppId_key" ON "User"("shortAppId");

-- CreateIndex
CREATE INDEX "LocalDeviceCredential_userId_idx" ON "LocalDeviceCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LocalDeviceCredential_userId_deviceId_key" ON "LocalDeviceCredential"("userId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Agency_customCode_key" ON "Agency"("customCode");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_name_key" ON "SubscriptionPlan"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PlanFeature_planId_featureKey_key" ON "PlanFeature"("planId", "featureKey");

-- CreateIndex
CREATE UNIQUE INDEX "HardwareProduct_name_key" ON "HardwareProduct"("name");

-- CreateIndex
CREATE UNIQUE INDEX "HardwareCommitmentTier_months_key" ON "HardwareCommitmentTier"("months");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyStaff_userId_agencyId_key" ON "AgencyStaff"("userId", "agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_agencyId_name_key" ON "Service"("agencyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_importToken_key" ON "Reservation"("importToken");

-- CreateIndex
CREATE INDEX "Reservation_agencyId_status_queueNumber_idx" ON "Reservation"("agencyId", "status", "queueNumber");

-- CreateIndex
CREATE INDEX "Reservation_agencyId_serviceId_status_idx" ON "Reservation"("agencyId", "serviceId", "status");

-- CreateIndex
CREATE INDEX "Reservation_userId_status_idx" ON "Reservation"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_userId_agencyId_key" ON "Favorite"("userId", "agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_reservationId_key" ON "Review"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_userId_agencyId_key" ON "Review"("userId", "agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "Counter_currentReservationId_key" ON "Counter"("currentReservationId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceRegistration_userId_deviceId_key" ON "DeviceRegistration"("userId", "deviceId");

-- CreateIndex
CREATE INDEX "UploadedFile_storageProvider_idx" ON "UploadedFile"("storageProvider");

-- CreateIndex
CREATE INDEX "UploadedFile_storageKey_idx" ON "UploadedFile"("storageKey");

-- CreateIndex
CREATE INDEX "DeletedRecord_modelName_deletedAt_idx" ON "DeletedRecord"("modelName", "deletedAt");

-- CreateIndex
CREATE INDEX "DeletedRecord_recordId_idx" ON "DeletedRecord"("recordId");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE INDEX "system_settings_category_idx" ON "system_settings"("category");

-- CreateIndex
CREATE INDEX "system_settings_key_idx" ON "system_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyDevice_pairingCode_key" ON "AgencyDevice"("pairingCode");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyDevice_deviceToken_key" ON "AgencyDevice"("deviceToken");

-- CreateIndex
CREATE INDEX "AgencyDevice_agencyId_idx" ON "AgencyDevice"("agencyId");

-- CreateIndex
CREATE INDEX "AgencyDevice_status_idx" ON "AgencyDevice"("status");

-- CreateIndex
CREATE INDEX "AgencyDevice_agencyId_status_idx" ON "AgencyDevice"("agencyId", "status");

-- CreateIndex
CREATE INDEX "AgencyDevice_pairingCode_idx" ON "AgencyDevice"("pairingCode");

-- CreateIndex
CREATE INDEX "AgencyDevice_deviceToken_idx" ON "AgencyDevice"("deviceToken");

-- CreateIndex
CREATE INDEX "AgencyDevice_lastHeartbeatAt_idx" ON "AgencyDevice"("lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "AgencyDevice_deviceFingerprint_idx" ON "AgencyDevice"("deviceFingerprint");

-- CreateIndex
CREATE INDEX "SavedTv_agencyId_idx" ON "SavedTv"("agencyId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedTv_agencyId_ip_key" ON "SavedTv"("agencyId", "ip");

-- CreateIndex
CREATE UNIQUE INDEX "DefaultPrinter_agencyId_key" ON "DefaultPrinter"("agencyId");

-- CreateIndex
CREATE INDEX "DefaultPrinter_agencyId_idx" ON "DefaultPrinter"("agencyId");

-- CreateIndex
CREATE INDEX "DeviceCommand_deviceId_status_idx" ON "DeviceCommand"("deviceId", "status");

-- CreateIndex
CREATE INDEX "DeviceCommand_createdAt_idx" ON "DeviceCommand"("createdAt");

-- CreateIndex
CREATE INDEX "AppVersion_platform_idx" ON "AppVersion"("platform");

-- CreateIndex
CREATE INDEX "AppVersion_isPublished_idx" ON "AppVersion"("isPublished");

-- CreateIndex
CREATE UNIQUE INDEX "AppVersion_platform_version_key" ON "AppVersion"("platform", "version");

-- CreateIndex
CREATE INDEX "DelayedJob_status_executeAt_idx" ON "DelayedJob"("status", "executeAt");

-- CreateIndex
CREATE INDEX "DelayedJob_userId_reservationId_idx" ON "DelayedJob"("userId", "reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncChange_sequence_key" ON "SyncChange"("sequence");

-- CreateIndex
CREATE INDEX "SyncChange_agencyId_sequence_idx" ON "SyncChange"("agencyId", "sequence");

-- CreateIndex
CREATE INDEX "SyncChange_agencyId_model_recordId_idx" ON "SyncChange"("agencyId", "model", "recordId");

-- CreateIndex
CREATE INDEX "SyncChange_mutationId_idx" ON "SyncChange"("mutationId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncMutation_idempotencyKey_key" ON "SyncMutation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SyncMutation_agencyId_createdAt_idx" ON "SyncMutation"("agencyId", "createdAt");

-- CreateIndex
CREATE INDEX "SyncMutation_status_idx" ON "SyncMutation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyLocalState_agencyId_key" ON "AgencyLocalState"("agencyId");

-- CreateIndex
CREATE INDEX "idx_sync_conflicts_model" ON "_sync_conflicts"("modelName");

-- CreateIndex
CREATE INDEX "idx_sync_conflicts_resolution" ON "_sync_conflicts"("resolution");

-- CreateIndex
CREATE UNIQUE INDEX "idx_pending_mutations_idem" ON "_pending_mutations"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_pending_mutations_status" ON "_pending_mutations"("status");

-- CreateIndex
CREATE INDEX "idx_deferred_agency_status" ON "_deferred_changes"("agencyId", "status");

-- CreateIndex
CREATE INDEX "idx_deferred_status_next" ON "_deferred_changes"("status", "nextRetryAt");`
