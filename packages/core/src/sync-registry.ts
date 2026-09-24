/**
 * @blasti/core — Sync Contract Registry
 *
 * Authoritative model registry that defines the synchronization behavior
 * for every model. Replaces the scattered model lists in sync-service.js,
 * cloud sync routes, and field mappings.
 *
 * Phase 4 — BLASTI Database Architecture Upgrade
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SINGLE SOURCE OF TRUTH (Task 4-b, PARITY_SYNC_AUDIT §5-3)               │
 * │                                                                         │
 * │ THIS FILE IS CANONICAL. packages/core/sync-registry.json is a GENERATED │
 * │ artifact of this registry for the desktop local-api (plain JS run by    │
 * │ Node inside Electron — it cannot import TypeScript). If you change      │
 * │ anything in this file you MUST regenerate the JSON and commit it:       │
 * │                                                                         │
 * │   node packages/core/scripts/generate-sync-registry-json.js             │
 * │                                                                         │
 * │ Consumers of the JSON: apps/desktop/local-api/sync-service.js           │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// ─── Protocol Version ────────────────────────────────────────────────────────

/** Bumped on every breaking change to the sync wire format or conflict semantics. */
export const SYNC_PROTOCOL_VERSION = 2

// ─── Enums ────────────────────────────────────────────────────────────────────

export enum ConflictStrategy {
  /** Server authority — queue state, financial records */
  CLOUD_WINS = 'cloud_wins',
  /** Simple merge by updatedAt */
  LAST_WRITE_WINS = 'last_write_wins',
  /** Per-field merge with rules */
  FIELD_MERGE = 'field_merge',
  /** Version check + reject if stale */
  VERSION_AWARE = 'version_aware',
  /** Never update, only create (transactions) */
  APPEND_ONLY = 'append_only',
  /** Read-only from local perspective */
  CLOUD_AUTHORITATIVE = 'cloud_authoritative',
}

export enum SyncOperation {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
}

// ─── Sync Model Config ───────────────────────────────────────────────────────

export interface SyncModelConfig {
  /** Model name matching Prisma model (e.g., "Reservation") */
  model: string
  /** Prisma table/delegate name (e.g., "reservation") */
  delegate: string
  /** Human-readable label */
  label: string
  /** Is this model synchronized between local and cloud? */
  isSynced: boolean
  /** Is this model scoped to an agency? */
  isAgencyScoped: boolean
  /** Which agency field? (e.g., "agencyId" or via relation) */
  agencyField: string | null
  /** Conflict resolution strategy */
  conflictStrategy: ConflictStrategy
  /** Fields that are mutable (can be updated) */
  mutableFields: string[]
  /** Fields that are immutable after creation (e.g., id, createdAt) */
  immutableFields: string[]
  /** Fields that exist only locally (not synced to cloud) */
  localOnlyFields: string[]
  /** Fields that exist only on cloud (not synced to local) */
  cloudOnlyFields: string[]
  /** Fields to use for LWW comparison (usually ["updatedAt"]) */
  lwwFields: string[]
  /** For version-aware: the version field name */
  versionField: string
  /** For version-aware: the synced timestamp field */
  syncedAtField: string
  /** Dependency models that must sync BEFORE this model */
  dependencies: string[]
  /** Can this model be created offline? */
  canCreateOffline: boolean
  /** Can this model be updated offline? */
  canUpdateOffline: boolean
  /** Can this model be deleted offline? */
  canDeleteOffline: boolean
  /** Is this model read-only from the local perspective? */
  isReadOnly: boolean
  /** Ordering priority for sync (lower = sync first) */
  syncOrder: number
  /** Date fields that need ISO serialization */
  dateFields: string[]
}

// ─── Queue State Transitions ─────────────────────────────────────────────────

/** Valid state transitions for Reservation status (queue operations). */
export const QUEUE_STATE_TRANSITIONS: Record<string, string[]> = {
  WAITING: ['CALLED', 'CANCELLED', 'NO_SHOW'],
  CALLED: ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'WAITING'], // WAITING allows re-queue
  COMPLETED: [],   // Terminal state
  CANCELLED: [],   // Terminal state
  NO_SHOW: ['WAITING'], // Can re-enter queue
  PAUSED: ['WAITING', 'CANCELLED'], // Paused → resume or cancel
}

// ─── SYNC_REGISTRY ───────────────────────────────────────────────────────────

export const SYNC_REGISTRY: SyncModelConfig[] = [
  // ── Synced Models (19 entries) ───────────────────────────────────────────

  {
    model: 'Agency',
    delegate: 'agency',
    label: 'Agency',
    isSynced: true,
    isAgencyScoped: true,
    agencyField: 'id',
    conflictStrategy: ConflictStrategy.FIELD_MERGE,
    mutableFields: [
      'name', 'nameFr', 'nameAr', 'customCode', 'category', 'address', 'city',
      'wilaya', 'phone', 'email', 'website', 'logoUrl', 'logoStorageProvider',
      'logoStorageKey', 'coverUrl', 'coverStorageProvider', 'coverStorageKey',
      'description', 'descriptionFr', 'descriptionAr', 'averageServiceTime',
      'maxActiveReservations', 'autoPauseWhenFull', 'isSponsored',
      'subscriptionPlanId', 'subscriptionTier', 'subscriptionStatus',
      'workingHoursStart', 'workingHoursEnd', 'isQueueOpen', 'isActive',
      'kioskModeEnabled', 'sponsorSms', 'smsBalance', 'gracePeriodEndsAt',
      'subscriptionStartsAt', 'subscriptionExpiresAt', 'ownerId',
    ],
    immutableFields: ['id', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 4,
    dateFields: ['createdAt', 'updatedAt', 'gracePeriodEndsAt', 'subscriptionStartsAt', 'subscriptionExpiresAt', 'syncedAt'],
  },

  {
    model: 'User',
    delegate: 'user',
    label: 'User',
    isSynced: true,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
    mutableFields: [
      'username', 'fullName', 'email', 'phoneNumber', 'shortAppId',
      'role', 'language', 'avatarUrl', 'avatarStorageProvider', 'avatarStorageKey',
      'freeSmsCount', 'notificationPreferences', 'reminderMinutes',
      'smsNotificationsEnabled', 'notificationPref', 'isAppOnline', 'fcmToken',
      'isActive', 'lastRoleChangeAt',
    ],
    immutableFields: ['id', 'passwordHash', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 1,
    dateFields: ['createdAt', 'updatedAt', 'lastRoleChangeAt', 'syncedAt'],
  },

  {
    model: 'AgencyStaff',
    delegate: 'agencyStaff',
    label: 'Agency Staff',
    isSynced: true,
    isAgencyScoped: true,
    agencyField: 'agencyId',
    conflictStrategy: ConflictStrategy.VERSION_AWARE,
    mutableFields: [
      'role', 'branchId', 'canManageQueue', 'canManageServices',
      'canManageStaff', 'canViewAnalytics', 'canManageBranches',
      'canManageWorkingHours', 'canExportData', 'canManageProfile',
      // Task 37-c: 2-tier staff authority — manager-only grants synced like
      // the other normalized permission booleans.
      'canCreateBranches', 'canDeleteBranches', 'canPurchaseSubscription',
      'canManageSubscription',
      'permissions', 'isActive',
    ],
    immutableFields: ['id', 'userId', 'agencyId', 'joinedAt', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Agency', 'User', 'Branch'],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 7,
    dateFields: ['joinedAt', 'createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'Service',
    delegate: 'service',
    label: 'Service',
    isSynced: true,
    isAgencyScoped: true,
    agencyField: 'agencyId',
    conflictStrategy: ConflictStrategy.VERSION_AWARE,
    mutableFields: ['name', 'nameFr', 'nameAr', 'description', 'prefix', 'isActive'],
    immutableFields: ['id', 'agencyId', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Agency'],
    canCreateOffline: true,
    canUpdateOffline: true,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 6,
    dateFields: ['createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'Branch',
    delegate: 'branch',
    label: 'Branch',
    isSynced: true,
    isAgencyScoped: true,
    agencyField: 'agencyId',
    conflictStrategy: ConflictStrategy.VERSION_AWARE,
    mutableFields: ['name', 'nameAr', 'nameFr', 'address', 'phone', 'isActive', 'isMain'],
    immutableFields: ['id', 'agencyId', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Agency'],
    canCreateOffline: true,
    canUpdateOffline: true,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 5,
    dateFields: ['createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'Counter',
    delegate: 'counter',
    label: 'Counter',
    isSynced: true,
    isAgencyScoped: true,
    agencyField: null, // scoped via Branch relation
    conflictStrategy: ConflictStrategy.VERSION_AWARE,
    mutableFields: ['number', 'name', 'nameAr', 'nameFr', 'isActive', 'branchId', 'staffId', 'occupiedAt', 'currentReservationId'],
    immutableFields: ['id', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Branch'],
    canCreateOffline: true,
    canUpdateOffline: true,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 8,
    dateFields: ['createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'QueueSettings',
    delegate: 'queueSettings',
    label: 'Queue Settings',
    isSynced: true,
    isAgencyScoped: true,
    agencyField: 'agencyId',
    conflictStrategy: ConflictStrategy.FIELD_MERGE,
    mutableFields: [
      'currentServingNumber', 'lastIssuedNumber', 'isPaused', 'pausedAt', 'openedAt',
    ],
    immutableFields: ['id', 'agencyId', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Agency'],
    canCreateOffline: true,
    canUpdateOffline: true,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 9,
    dateFields: ['pausedAt', 'openedAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'Reservation',
    delegate: 'reservation',
    label: 'Reservation',
    isSynced: true,
    isAgencyScoped: true,
    agencyField: 'agencyId',
    conflictStrategy: ConflictStrategy.CLOUD_WINS,
    mutableFields: [
      'status', 'estimatedWait', 'calledAt', 'completedAt', 'cancelledAt',
      'rating', 'feedback', 'notes', 'ratedAt', 'reminderSent', 'reminderSentAt',
      'smsReminderSent', 'smsReminderSentAt', 'skippedForNoShow', 'skippedAt',
      'reclaimRequestedAt', 'deferredTimeoutAt', 'preferredTime', 'fixedTimeEnabled',
      'postponeCount', 'isWalkIn', 'walkInCustomerName', 'counterId',
    ],
    immutableFields: [
      'id', 'userId', 'agencyId', 'serviceId', 'queueNumber', 'displayNumber',
      'joinedAt', 'reservedDate', 'offlineCreatedAt', 'syncDeviceId',
      'importToken', 'qrClaimedAt', 'qrClaimDeviceId',
      'priceSnapshot', 'currencySnapshot', 'planNameSnapshot',
      'createdAt',
    ],
    localOnlyFields: ['syncVersion', 'syncedAt', 'syncConflict'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Service', 'Branch', 'Counter'],
    canCreateOffline: true,
    canUpdateOffline: true,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 10,
    dateFields: [
      'joinedAt', 'calledAt', 'completedAt', 'cancelledAt', 'ratedAt',
      'reminderSentAt', 'smsReminderSentAt', 'skippedAt', 'reclaimRequestedAt',
      'deferredTimeoutAt', 'offlineCreatedAt', 'qrClaimedAt', 'syncedAt',
    ],
  },

  {
    model: 'Transaction',
    delegate: 'transaction',
    label: 'Transaction',
    isSynced: true,
    isAgencyScoped: true,
    agencyField: 'agencyId',
    conflictStrategy: ConflictStrategy.APPEND_ONLY,
    mutableFields: [
      'status', 'rejectionReason', 'reviewedBy', 'reviewedAt',
      'amountPaid', 'planName', 'version', 'paymentProvider', 'providerRef',
      'webhookVerified', 'reconciledAt', 'reconciledBy',
    ],
    immutableFields: [
      'id', 'agencyId', 'amount', 'plan', 'paymentMethod', 'receiptUrl',
      'receiptStorageProvider', 'receiptStorageKey', 'priceSnapshot',
      'currencySnapshot', 'createdAt', 'updatedAt',
    ],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Reservation'],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 11,
    dateFields: ['reviewedAt', 'reconciledAt', 'createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'SmsSettings',
    delegate: 'smsSettings',
    label: 'SMS Settings',
    isSynced: true,
    isAgencyScoped: false, // Part AF: GLOBAL platform singleton (no agencyId column)
    agencyField: null, // singleton per agency, linked via relation
    conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
    mutableFields: [
      'provider', 'apiUrl', 'apiKey', 'senderName', 'enabled',
      'smsPerReminder', 'maxSmsPerDay', 'testPhoneNumber',
      'templateTurnApproaching', 'templateYourTurn', 'templateNoShow', 'templateCustom',
    ],
    immutableFields: ['id', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Agency'],
    canCreateOffline: true,
    canUpdateOffline: true,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 12,
    dateFields: ['createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'PaymentSettings',
    delegate: 'paymentSettings',
    label: 'Payment Settings',
    isSynced: true,
    isAgencyScoped: false, // Part AF: GLOBAL platform singleton (no agencyId column)
    agencyField: null, // singleton per agency
    conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
    mutableFields: [
      'ccpEnabled', 'bankEnabled', 'electronicEnabled', 'ccpAccount', 'ccpKey',
      'bankName', 'bankAccount', 'bankRib', 'ewalletNumber',
    ],
    immutableFields: ['id', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Agency'],
    canCreateOffline: true,
    canUpdateOffline: true,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 13,
    dateFields: ['createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'Notification',
    delegate: 'notification',
    label: 'Notification',
    isSynced: true,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: ['isRead'],
    immutableFields: ['id', 'userId', 'type', 'title', 'message', 'entityId', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['User'],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 14,
    dateFields: ['createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'Announcement',
    delegate: 'announcement',
    label: 'Announcement',
    isSynced: true,
    isAgencyScoped: true,
    agencyField: 'agencyId',
    conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
    mutableFields: ['message', 'type', 'isActive', 'expiresAt'],
    immutableFields: ['id', 'agencyId', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Agency'],
    canCreateOffline: true,
    canUpdateOffline: true,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 15,
    dateFields: ['expiresAt', 'createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'GlobalAnnouncement',
    delegate: 'globalAnnouncement',
    label: 'Global Announcement',
    isSynced: true,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'message', 'type', 'createdBy', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 16,
    dateFields: ['createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'Review',
    delegate: 'review',
    label: 'Review',
    isSynced: true,
    isAgencyScoped: true,
    agencyField: 'agencyId',
    conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
    mutableFields: ['rating', 'comment', 'replyText', 'repliedAt'],
    immutableFields: ['id', 'userId', 'agencyId', 'reservationId', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Reservation', 'User'],
    canCreateOffline: true,
    canUpdateOffline: true,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 17,
    dateFields: ['repliedAt', 'createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'Favorite',
    delegate: 'favorite',
    label: 'Favorite',
    isSynced: true,
    isAgencyScoped: true,
    agencyField: 'agencyId',
    conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
    mutableFields: [],
    immutableFields: ['id', 'userId', 'agencyId', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['User', 'Agency'],
    canCreateOffline: true,
    canUpdateOffline: false,
    canDeleteOffline: true,
    isReadOnly: false,
    syncOrder: 18,
    dateFields: ['createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'FAQ',
    delegate: 'faq',
    label: 'FAQ',
    isSynced: true,
    isAgencyScoped: false, // Part AM: global content model (no agencyId column)
    agencyField: null, // global FAQ, not directly agency-scoped in schema
    conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
    mutableFields: ['question', 'questionFr', 'questionAr', 'answer', 'answerFr', 'answerAr', 'category', 'order', 'isActive'],
    immutableFields: ['id', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Agency'],
    canCreateOffline: true,
    canUpdateOffline: true,
    canDeleteOffline: false,
    isReadOnly: false,
    syncOrder: 19,
    dateFields: ['createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'SubscriptionPlan',
    delegate: 'subscriptionPlan',
    label: 'Subscription Plan',
    isSynced: true,
    isAgencyScoped: false, // Part AM: global platform model (ownerAgencyId nullable, not scoping)
    agencyField: 'ownerAgencyId',
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: [
      'id', 'name', 'displayName', 'displayNameAr', 'displayNameFr',
      'description', 'descriptionAr', 'descriptionFr', 'price', 'currency',
      'billingCycle', 'maxServices', 'maxBranches', 'maxStaff',
      'maxActiveReservations', 'maxSmsPerMonth', 'kioskModeEnabled',
      'analyticsEnabled', 'priorityListing', 'customBranding', 'apiAccess',
      'isActive', 'sortOrder', 'quarterlyDiscount', 'semiAnnualDiscount',
      'annualDiscount', 'biennialDiscount', 'isEnterprise', 'ownerAgencyId',
      'createdAt', 'updatedAt',
    ],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['Agency'],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 2,
    dateFields: ['createdAt', 'updatedAt', 'syncedAt'],
  },

  {
    model: 'PlanFeature',
    delegate: 'planFeature',
    label: 'Plan Feature',
    isSynced: true,
    isAgencyScoped: false, // Part AM: global platform model, scoped via plan relation only
    agencyField: null, // scoped via SubscriptionPlan relation
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'planId', 'featureKey', 'featureName', 'featureNameAr', 'featureNameFr', 'enabled', 'limitValue', 'createdAt', 'updatedAt'],
    localOnlyFields: ['syncVersion', 'syncedAt'],
    cloudOnlyFields: [],
    lwwFields: ['updatedAt'],
    versionField: 'syncVersion',
    syncedAtField: 'syncedAt',
    dependencies: ['SubscriptionPlan'],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 3,
    dateFields: ['createdAt', 'updatedAt', 'syncedAt'],
  },

  // ── Non-Synced (Cloud-Only) Models ───────────────────────────────────────

  {
    model: 'HardwareProduct',
    delegate: 'hardwareProduct',
    label: 'Hardware Product',
    isSynced: false,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'name', 'nameAr', 'nameFr', 'description', 'descriptionAr', 'descriptionFr', 'category', 'basePrice', 'isActive', 'sortOrder', 'createdAt', 'updatedAt'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 100,
    dateFields: ['createdAt', 'updatedAt'],
  },

  {
    model: 'HardwareOrder',
    delegate: 'hardwareOrder',
    label: 'Hardware Order',
    isSynced: false,
    isAgencyScoped: true,
    agencyField: 'agencyId',
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'agencyId', 'paymentModel', 'commitmentMonths', 'totalBasePrice', 'extraPercentage', 'monthlyExtra', 'upfrontTotal', 'status', 'createdAt', 'updatedAt'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 101,
    dateFields: ['createdAt', 'updatedAt'],
  },

  {
    model: 'HardwareOrderItem',
    delegate: 'hardwareOrderItem',
    label: 'Hardware Order Item',
    isSynced: false,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'orderId', 'productId', 'quantity', 'unitPrice', 'createdAt'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 102,
    dateFields: ['createdAt'],
  },

  {
    model: 'EnterpriseContractRequest',
    delegate: 'enterpriseContractRequest',
    label: 'Enterprise Contract Request',
    isSynced: false,
    isAgencyScoped: true,
    agencyField: 'agencyId',
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'agencyId', 'agencyName', 'contactEmail', 'contactPhone', 'message', 'requestedFeatures', 'branchesNeeded', 'countersNeeded', 'hardwareNeeded', 'status', 'adminNotes', 'customPlanId', 'createdAt', 'updatedAt'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 103,
    dateFields: ['createdAt', 'updatedAt'],
  },

  {
    model: 'HardwareSettings',
    delegate: 'hardwareSettings',
    label: 'Hardware Settings',
    isSynced: false,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'hardwareEnabled', 'upfrontDiscount', 'createdAt', 'updatedAt'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 104,
    dateFields: ['createdAt', 'updatedAt'],
  },

  {
    model: 'HardwareCommitmentTier',
    delegate: 'hardwareCommitmentTier',
    label: 'Hardware Commitment Tier',
    isSynced: false,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'months', 'label', 'labelAr', 'labelFr', 'extraPercentage', 'isActive', 'sortOrder'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 105,
    dateFields: [],
  },

  {
    model: 'SmsLog',
    delegate: 'smsLog',
    label: 'SMS Log',
    isSynced: false,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.APPEND_ONLY,
    mutableFields: [],
    immutableFields: ['id', 'userId', 'phoneNumber', 'message', 'status', 'provider', 'errorMessage', 'smsSettingsId', 'createdAt', 'updatedAt'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 106,
    dateFields: ['createdAt', 'updatedAt'],
  },

  {
    model: 'AuditLog',
    delegate: 'auditLog',
    label: 'Audit Log',
    isSynced: false,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.APPEND_ONLY,
    mutableFields: [],
    immutableFields: ['id', 'userId', 'action', 'entityType', 'entityId', 'details', 'ipAddress', 'createdAt', 'updatedAt'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 107,
    dateFields: ['createdAt', 'updatedAt'],
  },

  {
    model: 'DeviceRegistration',
    delegate: 'deviceRegistration',
    label: 'Device Registration',
    isSynced: false,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'userId', 'platform', 'deviceToken', 'deviceId', 'deviceFingerprint', 'appVersion', 'lastActiveAt', 'createdAt', 'updatedAt'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 108,
    dateFields: ['lastActiveAt', 'createdAt', 'updatedAt'],
  },

  {
    model: 'UploadedFile',
    delegate: 'uploadedFile',
    label: 'Uploaded File',
    isSynced: false,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'storageProvider', 'storageKey', 'originalName', 'contentType', 'size', 'createdAt', 'updatedAt'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 109,
    dateFields: ['createdAt', 'updatedAt'],
  },

  {
    model: 'AppVersion',
    delegate: 'appVersion',
    label: 'App Version',
    isSynced: false,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'platform', 'version', 'versionCode', 'releaseNotes', 'releaseNotesAr', 'releaseNotesFr', 'isMandatory', 'isPublished', 'isPatch', 'downloadUrl', 'fileStorageKey', 'fileStorageProvider', 'fileName', 'fileSize', 'fileHash', 'minAppVersion', 'publishedAt', 'downloadCount', 'createdAt', 'updatedAt'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 110,
    dateFields: ['publishedAt', 'createdAt', 'updatedAt'],
  },

  {
    model: 'DelayedJob',
    delegate: 'delayedJob',
    label: 'Delayed Job',
    isSynced: false,
    isAgencyScoped: false,
    agencyField: null,
    conflictStrategy: ConflictStrategy.CLOUD_AUTHORITATIVE,
    mutableFields: [],
    immutableFields: ['id', 'reservationId', 'userId', 'jobType', 'payload', 'executeAt', 'status', 'createdAt'],
    localOnlyFields: [],
    cloudOnlyFields: [],
    lwwFields: [],
    versionField: '',
    syncedAtField: '',
    dependencies: [],
    canCreateOffline: false,
    canUpdateOffline: false,
    canDeleteOffline: false,
    isReadOnly: true,
    syncOrder: 111,
    dateFields: ['executeAt', 'createdAt'],
  },
]

// ─── Internal lookup map (lazy-initialized) ──────────────────────────────────

const _byModel = new Map<string, SyncModelConfig>()

function _ensureIndex(): void {
  if (_byModel.size === 0) {
    for (const cfg of SYNC_REGISTRY) {
      _byModel.set(cfg.model, cfg)
    }
  }
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

/** Get config for a model by its Prisma model name (e.g., "Reservation"). */
export function getSyncModelConfig(model: string): SyncModelConfig | undefined {
  _ensureIndex()
  return _byModel.get(model)
}

/** Get all synced models sorted by dependency order (syncOrder ascending). */
export function getSyncedModelsInOrder(): SyncModelConfig[] {
  return SYNC_REGISTRY
    .filter((c) => c.isSynced)
    .sort((a, b) => a.syncOrder - b.syncOrder)
}

/** Get all agency-scoped synced models. */
export function getAgencyScopedModels(): SyncModelConfig[] {
  return SYNC_REGISTRY.filter((c) => c.isSynced && c.isAgencyScoped)
}

/** Get models that can be created offline. */
export function getOfflineCreatableModels(): SyncModelConfig[] {
  return SYNC_REGISTRY.filter((c) => c.isSynced && c.canCreateOffline)
}

/** Check if a model is synced. */
export function isModelSynced(model: string): boolean {
  _ensureIndex()
  const cfg = _byModel.get(model)
  return cfg != null && cfg.isSynced
}

/**
 * Validate sync registry completeness — for startup assertion.
 *
 * Checks:
 *  1. Every synced model has a non-empty versionField and syncedAtField
 *  2. No duplicate model names
 *  3. All dependencies reference existing models
 *  4. Every synced model has at least one dateField
 *  5. mutableFields ∩ immutableFields = ∅
 */
export function validateSyncRegistry(): { valid: boolean; errors: string[] } {
  _ensureIndex()
  const errors: string[] = []
  const seen = new Set<string>()

  for (const cfg of SYNC_REGISTRY) {
    // Duplicate check
    if (seen.has(cfg.model)) {
      errors.push(`Duplicate model: ${cfg.model}`)
    }
    seen.add(cfg.model)

    // Synced-model invariants
    if (cfg.isSynced) {
      if (!cfg.versionField) {
        errors.push(`${cfg.model}: synced model missing versionField`)
      }
      if (!cfg.syncedAtField) {
        errors.push(`${cfg.model}: synced model missing syncedAtField`)
      }
      if (cfg.dateFields.length === 0) {
        errors.push(`${cfg.model}: synced model has no dateFields`)
      }
    }

    // Dependency references
    for (const dep of cfg.dependencies) {
      if (!_byModel.has(dep)) {
        errors.push(`${cfg.model}: dependency "${dep}" not found in registry`)
      }
    }

    // mutable ∩ immutable
    const mutableSet = new Set(cfg.mutableFields)
    for (const f of cfg.immutableFields) {
      if (mutableSet.has(f)) {
        errors.push(`${cfg.model}: field "${f}" is both mutable and immutable`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

// ─── DATE_FIELDS Union ───────────────────────────────────────────────────────

/** All date fields across all models that need ISO serialization during sync. */
export const DATE_FIELDS: Set<string> = new Set([
  // From sync-service.js (legacy)
  'joinedAt', 'calledAt', 'completedAt', 'cancelledAt', 'noShowAt',
  'pausedAt', 'createdAt', 'updatedAt', 'openedAt', 'repliedAt',
  'reviewedAt', 'lastRoleChangeAt', 'gracePeriodEndsAt',
  'subscriptionStartsAt', 'subscriptionExpiresAt', 'reminderSentAt',
  'smsReminderSentAt', 'skippedAt', 'reclaimRequestedAt', 'qrClaimedAt',
  'offlineCreatedAt', 'lastActiveAt', 'resolvedAt',
  'sentAt', 'scheduledAt', 'expiresAt', 'startsAt',
  // Additional from schema
  'deferredTimeoutAt', 'ratedAt', 'reconciledAt',
  'publishedAt', 'executeAt', 'syncedAt',
  'statusChangedAt', 'connectedAt', 'lastHeartbeatAt', 'lastSeenAt',
  'deliveredAt', 'completedAt', 'processedAt',
  'lastPulledAt', 'lastPushedAt', 'changedAt',
])
