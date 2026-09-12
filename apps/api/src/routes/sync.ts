/**
 * BLASTI Sync Routes — WatermelonDB Local-First Architecture (Phase 5)
 *
 * Provides incremental sync endpoints for pulling and pushing data
 * between local WatermelonDB clients and the central Prisma database.
 *
 * GET  /api/sync/status — Server sync status with cursor info
 * POST /api/sync/pull   — Cursor-based incremental pull using SyncChange
 * POST /api/sync/push   — Push local changes with idempotency & conflict detection
 */

import { Hono } from 'hono'
import { cloudDb } from '@blasti/cloud-db'
import { requireAuth, authErrorResponse, AuthError } from '../lib/auth'
import { isRealtimeHealthy } from '../lib/realtime-emit'
import {
  getChangesSinceCursor,
  advanceCursor,
  getCursor,
  getLatestSequence,
  processPushMutation,
  IdempotencyConflictError,
} from '../lib/sync-helpers'
import { SYNC_PROTOCOL_VERSION } from '@blasti/core/sync-registry'
import { z } from 'zod'

const app = new Hono()

// ─── In-memory sync tracking ────────────────────────────────────────────────

const agencyLastSync = new Map<string, Date>()
const agencyPendingEvents = new Map<string, number>()

export function markAgencySynced(agencyId: string): void {
  agencyLastSync.set(agencyId, new Date())
  agencyPendingEvents.set(agencyId, 0)
}

export function incrementPendingEvents(agencyId: string, count: number = 1): void {
  const current = agencyPendingEvents.get(agencyId) || 0
  agencyPendingEvents.set(agencyId, current + count)
}

// ─── Phase 5: Sync Models Definition ────────────────────────────────────────
// These models are synced between WatermelonDB (local) and Prisma (server)

const SYNC_MODELS = [
  'Agency',
  'Service',
  'Branch',
  'Counter',
  'Reservation',
  'Notification',
  'QueueSettings',
  'AgencyStaff',
  'Review',
  'User',
  // ── 9 models added for full sync coverage (Task 2a) ────────────────────
  'SmsSettings',
  'PaymentSettings',
  'Announcement',
  'GlobalAnnouncement',
  'Transaction',
  'SubscriptionPlan',
  'PlanFeature',
  'Favorite',
  'FAQ',
] as const

type SyncModel = typeof SYNC_MODELS[number]

// ─── Phase 4a: Role-Based Push Permissions ──────────────────────────────────
// Prevents "blind overwrite" exploit where a malicious client could push
// changes to restricted tables (e.g., Subscriptions, Agency settings)
// via WatermelonDB sync.

const ALLOWED_PUSH_PER_ROLE: Record<string, Record<string, { create: boolean; update: string[]; delete: boolean }>> = {
  CUSTOMER: {
    Reservation: { create: true, update: ['status', 'postponeCount'], delete: false },
    Notification: { create: false, update: ['isRead'], delete: false },
  },
  AGENCY_OWNER: {
    Reservation: { create: true, update: ['status', 'postponeCount', 'counterId', 'calledAt', 'completedAt', 'cancelledAt'], delete: false },
    Notification: { create: false, update: ['isRead'], delete: false },
    Service: { create: false, update: ['name', 'nameFr', 'nameAr', 'isActive'], delete: false },
    Branch: { create: false, update: ['name', 'nameAr', 'nameFr', 'address', 'phone', 'isActive'], delete: false },
    Counter: { create: false, update: ['name', 'nameAr', 'nameFr', 'isActive', 'staffId'], delete: false },
    QueueSettings: { create: false, update: ['isPaused', 'currentServingNumber', 'lastIssuedNumber'], delete: false },
  },
  AGENCY_STAFF: {
    Reservation: { create: true, update: ['status', 'counterId', 'calledAt', 'completedAt', 'cancelledAt'], delete: false },
    Notification: { create: false, update: ['isRead'], delete: false },
  },
  SUPER_ADMIN: {
    // Super admin can push to all sync models
    Agency: { create: false, update: ['name', 'nameFr', 'nameAr', 'isQueueOpen', 'isActive'], delete: false },
    Service: { create: true, update: ['name', 'nameFr', 'nameAr', 'prefix', 'isActive'], delete: true },
    Branch: { create: true, update: ['name', 'nameAr', 'nameFr', 'address', 'phone', 'isActive'], delete: true },
    Counter: { create: true, update: ['name', 'nameAr', 'nameFr', 'isActive', 'staffId'], delete: true },
    Reservation: { create: true, update: ['status', 'postponeCount', 'counterId', 'calledAt', 'completedAt', 'cancelledAt'], delete: true },
    Notification: { create: true, update: ['isRead', 'type', 'title', 'message'], delete: true },
    QueueSettings: { create: true, update: ['isPaused', 'currentServingNumber', 'lastIssuedNumber'], delete: false },
  },
}

// ─── Pull Schema ────────────────────────────────────────────────────────────

const pullSchema = z.object({
  cursor: z.number().optional(),    // Sequence cursor (cursor-based pull)
  lastPulledAt: z.string().optional(), // Legacy: ISO timestamp of last successful pull
  models: z.array(z.string()).optional(), // Which models to sync (default: all)
  agencyId: z.string().optional(), // Filter to specific agency
  limit: z.number().optional(),    // Max changes per request (default 500)
})

// POST /api/sync/pull — Cursor-based incremental pull using SyncChange
// Phase 5: Returns SyncChange records since cursor + record data for each change
app.post('/pull', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()
    const validation = pullSchema.safeParse(body)

    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid pull request', details: validation.error.issues }, 400)
    }

    const { cursor, lastPulledAt, agencyId, limit } = validation.data

    // Determine which agency(s) the user has access to
    let targetAgencyId = agencyId

    if (!targetAgencyId && user.role !== 'SUPER_ADMIN') {
      // Auto-resolve to user's agency
      const staffRecord = await cloudDb.agencyStaff.findFirst({
        where: { userId: user.id, isActive: true },
        select: { agencyId: true },
      })
      const ownedAgency = await cloudDb.agency.findFirst({
        where: { ownerId: user.id },
        select: { id: true },
      })
      targetAgencyId = staffRecord?.agencyId || ownedAgency?.id || undefined
    }

    if (!targetAgencyId) {
      return c.json({
        success: false,
        error: 'No agency found for user — specify agencyId',
      }, 400)
    }

    // ── Cursor-based pull using SyncChange ────────────────────────────────
    // If cursor is provided, use the new cursor-based approach
    // If only lastPulledAt is provided (legacy), resolve to a cursor
    let sinceSequence = cursor ?? 0

    if (!cursor && lastPulledAt) {
      // Legacy fallback: find the latest SyncChange sequence before lastPulledAt
      const since = new Date(lastPulledAt)
      const lastChangeBeforeCursor = await cloudDb.syncChange.findFirst({
        where: {
          agencyId: targetAgencyId,
          changedAt: { lt: since },
        },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      })
      sinceSequence = lastChangeBeforeCursor?.sequence ?? 0
    }

    // If no cursor at all, try loading from the SyncCursor table
    if (!cursor && !lastPulledAt) {
      sinceSequence = await getCursor(targetAgencyId)
    }

    // Fetch changes since cursor
    const { changes, hasMore, latestSequence } = await getChangesSinceCursor(
      targetAgencyId,
      sinceSequence,
      limit ?? 500,
    )

    // ── Hydrate changes with record data ─────────────────────────────────
    // For each SyncChange, fetch the current record state (for create/update)
    // or just the recordId (for delete)
    const hydratedChanges: Record<string, { created: any[]; updated: any[]; deleted: string[] }> = {}

    for (const model of SYNC_MODELS) {
      hydratedChanges[model] = { created: [], updated: [], deleted: [] }
    }

    // Group changes by model and operation for efficient batch fetching
    const changesByModelOp: Record<string, { create: string[]; update: string[]; delete: string[] }> = {}
    for (const change of changes) {
      if (!changesByModelOp[change.model]) {
        changesByModelOp[change.model] = { create: [], update: [], delete: [] }
      }
      changesByModelOp[change.model][change.operation as 'create' | 'update' | 'delete']?.push(change.recordId)
    }

    // Fetch record data for each model
    for (const [modelName, ops] of Object.entries(changesByModelOp)) {
      const allRecordIds = [...(ops.create || []), ...(ops.update || [])]

      if (allRecordIds.length === 0 && ops.delete.length === 0) continue

      // Add deletes directly
      if (hydratedChanges[modelName]) {
        hydratedChanges[modelName].deleted = ops.delete
      }

      // Fetch record data for creates and updates
      if (allRecordIds.length > 0) {
        const records = await fetchRecordsForModel(modelName, allRecordIds, targetAgencyId, user.id, user.role)

        for (const change of changes) {
          if (change.model !== modelName) continue
          if (change.operation === 'delete') continue

          const record = records.find((r: any) => r.id === change.recordId)
          if (!record) continue

          if (!hydratedChanges[modelName]) {
            hydratedChanges[modelName] = { created: [], updated: [], deleted: [] }
          }

          if (change.operation === 'create') {
            hydratedChanges[modelName].created.push(record)
          } else if (change.operation === 'update') {
            hydratedChanges[modelName].updated.push(record)
          }
        }
      }
    }

    // Also include deleted record tombstones for the legacy path
    const since = lastPulledAt ? new Date(lastPulledAt) : new Date(0)
    const deletedRecords = await cloudDb.deletedRecord.findMany({
      where: {
        deletedAt: { gte: since },
      },
      select: { modelName: true, recordId: true },
    })
    for (const dr of deletedRecords) {
      if (hydratedChanges[dr.modelName] && !hydratedChanges[dr.modelName].deleted.includes(dr.recordId)) {
        hydratedChanges[dr.modelName].deleted.push(dr.recordId)
      }
    }

    // Advance the cursor after successful pull
    if (changes.length > 0) {
      await advanceCursor(targetAgencyId, latestSequence)
      markAgencySynced(targetAgencyId)
    }

    return c.json({
      success: true,
      cursor: latestSequence,
      hasMore,
      changes: hydratedChanges,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    })
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      const err = authErrorResponse(error)
      return c.json({ success: err.success, error: err.error }, err.status as any)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// ─── Helper: fetch records for a model by IDs ──────────────────────────────

async function fetchRecordsForModel(
  modelName: string,
  recordIds: string[],
  agencyId: string,
  userId: string,
  userRole: string,
): Promise<any[]> {
  switch (modelName) {
    case 'Agency': {
      return cloudDb.agency.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, name: true, nameFr: true, nameAr: true,
          customCode: true, category: true, address: true, city: true,
          phone: true, email: true, averageServiceTime: true,
          maxActiveReservations: true, isQueueOpen: true,
          subscriptionTier: true, subscriptionStatus: true,
          workingHoursStart: true, workingHoursEnd: true,
          isActive: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    case 'Service': {
      return cloudDb.service.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, agencyId: true, name: true, nameFr: true, nameAr: true,
          prefix: true, isActive: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    case 'Branch': {
      return cloudDb.branch.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, agencyId: true, name: true, nameAr: true, nameFr: true,
          address: true, phone: true, isMain: true, isActive: true,
          syncVersion: true, createdAt: true, updatedAt: true,
        },
      })
    }
    case 'Counter': {
      return cloudDb.counter.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, branchId: true, number: true, name: true,
          nameAr: true, nameFr: true, isActive: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    case 'Reservation': {
      const where: any = { id: { in: recordIds } }
      if (userRole === 'CUSTOMER') where.userId = userId
      return cloudDb.reservation.findMany({
        where,
        select: {
          id: true, userId: true, agencyId: true, serviceId: true,
          queueNumber: true, displayNumber: true, status: true,
          estimatedWait: true, joinedAt: true, calledAt: true,
          completedAt: true, cancelledAt: true, preferredTime: true,
          fixedTimeEnabled: true, postponeCount: true, isWalkIn: true,
          walkInCustomerName: true, counterId: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    case 'Notification': {
      return cloudDb.notification.findMany({
        where: { id: { in: recordIds }, userId },
        select: {
          id: true, userId: true, type: true, title: true,
          message: true, isRead: true, entityId: true, syncVersion: true,
          createdAt: true,
        },
      })
    }
    case 'QueueSettings': {
      return cloudDb.queueSettings.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, agencyId: true, currentServingNumber: true,
          lastIssuedNumber: true, isPaused: true, pausedAt: true,
          syncVersion: true, updatedAt: true,
        },
      })
    }
    case 'AgencyStaff': {
      return cloudDb.agencyStaff.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, userId: true, agencyId: true, role: true,
          branchId: true, isActive: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    case 'Review': {
      return cloudDb.review.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, userId: true, agencyId: true, rating: true,
          comment: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    case 'User': {
      return cloudDb.user.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, username: true, fullName: true, email: true,
          phoneNumber: true, role: true, language: true,
          isActive: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    // ── 9 models added for full sync coverage (Task 2a) ──────────────────
    case 'SmsSettings': {
      return cloudDb.smsSettings.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, provider: true, apiUrl: true, senderName: true,
          enabled: true, smsPerReminder: true, maxSmsPerDay: true,
          testPhoneNumber: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    case 'PaymentSettings': {
      return cloudDb.paymentSettings.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, ccpEnabled: true, bankEnabled: true, electronicEnabled: true,
          ccpAccount: true, ccpKey: true, bankName: true, bankAccount: true,
          bankRib: true, ewalletNumber: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    case 'Announcement': {
      return cloudDb.announcement.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, agencyId: true, message: true, type: true,
          isActive: true, expiresAt: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    case 'GlobalAnnouncement': {
      return cloudDb.globalAnnouncement.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, message: true, type: true, createdBy: true,
          syncVersion: true, createdAt: true, updatedAt: true,
        },
      })
    }
    case 'Transaction': {
      return cloudDb.transaction.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, agencyId: true, amount: true, plan: true,
          paymentMethod: true, status: true, rejectionReason: true,
          reviewedBy: true, reviewedAt: true, amountPaid: true,
          planName: true, priceSnapshot: true, currencySnapshot: true,
          version: true, paymentProvider: true, providerRef: true,
          webhookVerified: true, reconciledAt: true, reconciledBy: true,
          syncVersion: true, createdAt: true, updatedAt: true,
        },
      })
    }
    case 'SubscriptionPlan': {
      return cloudDb.subscriptionPlan.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, name: true, displayName: true, displayNameAr: true,
          displayNameFr: true, price: true, currency: true,
          billingCycle: true, maxServices: true, maxBranches: true,
          maxStaff: true, maxActiveReservations: true, maxSmsPerMonth: true,
          kioskModeEnabled: true, analyticsEnabled: true, priorityListing: true,
          customBranding: true, apiAccess: true, isActive: true,
          sortOrder: true, quarterlyDiscount: true, semiAnnualDiscount: true,
          annualDiscount: true, biennialDiscount: true, isEnterprise: true,
          ownerAgencyId: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    case 'PlanFeature': {
      return cloudDb.planFeature.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, planId: true, featureKey: true,
          featureName: true, featureNameAr: true, featureNameFr: true,
          enabled: true, limitValue: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
    }
    case 'Favorite': {
      return cloudDb.favorite.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, userId: true, agencyId: true,
          syncVersion: true, createdAt: true, updatedAt: true,
        },
      })
    }
    case 'FAQ': {
      return cloudDb.faq.findMany({
        where: { id: { in: recordIds } },
        select: {
          id: true, question: true, questionFr: true, questionAr: true,
          answer: true, answerFr: true, answerAr: true,
          category: true, order: true, isActive: true,
          syncVersion: true, createdAt: true, updatedAt: true,
        },
      })
    }
    default:
      return []
  }
}

// ─── Push Schema ────────────────────────────────────────────────────────────

const pushSchema = z.object({
  changes: z.record(z.string(), z.any()),
  lastPulledAt: z.string().optional(),
  cursor: z.number().optional(),
})

// POST /api/sync/push — Push local changes to the server
// Phase 5: Uses processPushMutation() with idempotency and conflict detection
app.post('/push', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()

    const validation = pushSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid push request', details: validation.error.issues }, 400)
    }

    const { changes } = validation.data
    const results: Record<string, { created: number; updated: number; deleted: number; skipped?: string; conflicts?: any[] }> = {}

    // Phase 4a: Resolve the user's role for permission checks
    const userRole = user.role as string
    const rolePermissions = ALLOWED_PUSH_PER_ROLE[userRole]

    // Determine agency ID for SyncChange recording
    let agencyId: string | undefined
    const staffRecord = await cloudDb.agencyStaff.findFirst({
      where: { userId: user.id, isActive: true },
      select: { agencyId: true },
    })
    const ownedAgency = await cloudDb.agency.findFirst({
      where: { ownerId: user.id },
      select: { id: true },
    })
    agencyId = staffRecord?.agencyId || ownedAgency?.id

    // Extract idempotency key from header if present
    const idempotencyKeyPrefix = c.req.header('X-Idempotency-Key') || ''

    // Process each model's changes
    for (const [modelName, modelChanges] of Object.entries(changes)) {
      if (!SYNC_MODELS.includes(modelName as SyncModel)) continue

      const mc = modelChanges as { created?: any[]; updated?: any[]; deleted?: string[] }
      results[modelName] = { created: 0, updated: 0, deleted: 0, conflicts: [] }

      // Phase 4a: Check if this model is allowed for the user's role
      if (!rolePermissions || !rolePermissions[modelName]) {
        console.warn(`[SYNC] User role ${userRole} attempted push to ${modelName} — skipped (not allowed)`)
        results[modelName].skipped = 'Model not allowed for role'
        continue
      }

      const modelPerms = rolePermissions[modelName]

      // Process creates — wrapped in processPushMutation
      if (mc.created && Array.isArray(mc.created)) {
        if (!modelPerms.create) {
          if (mc.created.length > 0) {
            console.warn(`[SYNC] User role ${userRole} attempted create on ${modelName} — skipped (not allowed)`)
            results[modelName].skipped = 'Create not allowed for role'
          }
        } else {
          for (let i = 0; i < mc.created.length; i++) {
            const record = mc.created[i]
            try {
              // Only allow creating reservations that belong to the user
              if (modelName === 'Reservation' && record.userId && record.userId !== user.id) {
                results[modelName].conflicts!.push({
                  recordId: record.id,
                  reason: 'Cannot create reservation for another user',
                })
                continue
              }

              const idemKey = idempotencyKeyPrefix
                ? `${idempotencyKeyPrefix}:${modelName}:create:${record.id}`
                : undefined

              const pushResult = await processPushMutation({
                agencyId: agencyId || record.agencyId || '',
                model: modelName,
                recordId: record.id,
                operation: 'create',
                data: record,
                idempotencyKey: idemKey,
                expectedVersion: record.syncVersion,
              })

              if (pushResult.success) {
                results[modelName].created++
              } else if (pushResult.conflict) {
                results[modelName].conflicts!.push({
                  recordId: record.id,
                  ...pushResult.conflict,
                })
              }
            } catch (err) {
              console.warn(`[SYNC] Failed to create ${modelName}:`, err)
              results[modelName].conflicts!.push({
                recordId: record.id,
                reason: err instanceof Error ? err.message : 'Unknown error',
              })
            }
          }
        }
      }

      // Process updates — Phase 4a: Only allow specified fields per role
      if (mc.updated && Array.isArray(mc.updated)) {
        const allowedUpdateFields = modelPerms.update
        for (let i = 0; i < mc.updated.length; i++) {
          const record = mc.updated[i]
          try {
            // Filter record to only include allowed update fields
            const filteredData: Record<string, unknown> = {}
            for (const field of allowedUpdateFields) {
              if (field in record) {
                filteredData[field] = record[field]
              }
            }

            if (Object.keys(filteredData).length === 0) {
              continue // No allowed fields in the update
            }

            // Ownership check for customers
            if (modelName === 'Reservation' && userRole === 'CUSTOMER') {
              const existing = await cloudDb.reservation.findFirst({
                where: { id: record.id, userId: user.id },
                select: { id: true },
              })
              if (!existing) {
                results[modelName].conflicts!.push({
                  recordId: record.id,
                  reason: 'Cannot update another user\'s reservation',
                })
                continue
              }
            }

            if (modelName === 'Notification') {
              const existing = await cloudDb.notification.findFirst({
                where: { id: record.id, userId: user.id },
                select: { id: true },
              })
              if (!existing) {
                results[modelName].conflicts!.push({
                  recordId: record.id,
                  reason: 'Cannot update another user\'s notification',
                })
                continue
              }
            }

            const idemKey = idempotencyKeyPrefix
              ? `${idempotencyKeyPrefix}:${modelName}:update:${record.id}`
              : undefined

            const pushResult = await processPushMutation({
              agencyId: agencyId || record.agencyId || '',
              model: modelName,
              recordId: record.id,
              operation: 'update',
              data: filteredData,
              idempotencyKey: idemKey,
              expectedVersion: record.syncVersion,
            })

            if (pushResult.success) {
              results[modelName].updated++
            } else if (pushResult.conflict) {
              results[modelName].conflicts!.push({
                recordId: record.id,
                ...pushResult.conflict,
              })
            }
          } catch (err) {
            console.warn(`[SYNC] Failed to update ${modelName}:`, err)
            results[modelName].conflicts!.push({
              recordId: record.id,
              reason: err instanceof Error ? err.message : 'Unknown error',
            })
          }
        }
      }

      // Process deletes — Phase 4a: Only if delete is allowed for role+model
      if (mc.deleted && Array.isArray(mc.deleted)) {
        if (!modelPerms.delete) {
          if (mc.deleted.length > 0) {
            console.warn(`[SYNC] User role ${userRole} attempted delete on ${modelName} — skipped (not allowed)`)
            results[modelName].skipped = 'Delete not allowed for role'
          }
        } else {
          for (const recordId of mc.deleted) {
            try {
              const idemKey = idempotencyKeyPrefix
                ? `${idempotencyKeyPrefix}:${modelName}:delete:${recordId}`
                : undefined

              const pushResult = await processPushMutation({
                agencyId: agencyId || '',
                model: modelName,
                recordId,
                operation: 'delete',
                data: {},
                idempotencyKey: idemKey,
              })

              if (pushResult.success) {
                results[modelName].deleted++
              } else if (pushResult.conflict) {
                results[modelName].conflicts!.push({
                  recordId,
                  ...pushResult.conflict,
                })
              }
            } catch (err) {
              console.warn(`[SYNC] Failed to delete ${modelName}:`, err)
              results[modelName].conflicts!.push({
                recordId,
                reason: err instanceof Error ? err.message : 'Unknown error',
              })
            }
          }
        }
      }

      // Clean up empty conflicts arrays
      if (results[modelName].conflicts!.length === 0) {
        delete results[modelName].conflicts
      }
    }

    return c.json({ success: true, results })
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      const err = authErrorResponse(error)
      return c.json({ success: err.success, error: err.error }, err.status as any)
    }
    if (error instanceof IdempotencyConflictError) {
      return c.json({ success: false, error: error.message }, 409)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// GET /api/sync/status — Server sync status endpoint
// Phase 5: Returns cursor info, pending mutations count, etc.
app.get('/status', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')

    let realtimeHealthy = false
    try {
      realtimeHealthy = await isRealtimeHealthy()
    } catch {
      realtimeHealthy = false
    }

    const now = new Date()

    const baseResponse = {
      serverTimestamp: now.toISOString(),
      serverUnixMs: now.getTime(),
      connectionStatus: realtimeHealthy ? 'connected' : 'disconnected',
      realtimeServiceHealthy: realtimeHealthy,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    }

    if (!agencyId) {
      return c.json({ success: true, ...baseResponse, agency: null })
    }

    const agency = await cloudDb.agency.findUnique({
      where: { id: agencyId },
      select: { id: true },
    })

    if (!agency) {
      return c.json({ success: true, ...baseResponse, agency: null })
    }

    // ── Cursor-based status ───────────────────────────────────────────────
    const [syncCursor, latestSeq, pendingMutations, lastSyncTime] = await Promise.all([
      // SyncCursor for this agency
      cloudDb.syncCursor.findUnique({
        where: { agencyId },
        select: { lastPulledSeq: true, lastPushedSeq: true, lastPulledAt: true, lastPushedAt: true },
      }),
      // Latest SyncChange sequence
      getLatestSequence(agencyId),
      // Pending SyncMutations count
      cloudDb.syncMutation.count({
        where: { agencyId, status: 'pending' },
      }),
      // In-memory last sync time
      Promise.resolve(agencyLastSync.get(agencyId)),
    ])

    const [currentWaiting, currentCalled, queueSettings, latestReservation] = await Promise.all([
      cloudDb.reservation.count({ where: { agencyId, status: 'WAITING' } }),
      cloudDb.reservation.count({ where: { agencyId, status: 'CALLED' } }),
      cloudDb.queueSettings.findFirst({ where: { agencyId }, select: { updatedAt: true, isPaused: true } }),
      cloudDb.reservation.findFirst({ where: { agencyId }, orderBy: { joinedAt: 'desc' }, select: { joinedAt: true } }),
    ])

    let effectiveLastSync: Date | null = lastSyncTime || null
    if (syncCursor?.lastPulledAt && (!effectiveLastSync || syncCursor.lastPulledAt > effectiveLastSync)) {
      effectiveLastSync = syncCursor.lastPulledAt
    }
    if (queueSettings?.updatedAt && (!effectiveLastSync || queueSettings.updatedAt > effectiveLastSync)) {
      effectiveLastSync = queueSettings.updatedAt
    }
    if (latestReservation?.joinedAt && (!effectiveLastSync || latestReservation.joinedAt > effectiveLastSync)) {
      effectiveLastSync = latestReservation.joinedAt
    }

    const totalPendingEvents = currentWaiting + currentCalled
    const changesBehind = latestSeq - (syncCursor?.lastPulledSeq ?? 0)

    return c.json({
      success: true,
      ...baseResponse,
      agency: {
        agencyId,
        lastSyncTime: effectiveLastSync ? effectiveLastSync.toISOString() : null,
        secondsSinceLastSync: effectiveLastSync ? Math.round((now.getTime() - effectiveLastSync.getTime()) / 1000) : null,
        pendingEvents: totalPendingEvents,
        isPaused: queueSettings?.isPaused ?? false,
        currentWaiting,
        currentCalled,
        // ── Cursor-based sync info ──────────────────────────────────
        cursor: {
          lastPulledSeq: syncCursor?.lastPulledSeq ?? 0,
          lastPushedSeq: syncCursor?.lastPushedSeq ?? 0,
          lastPulledAt: syncCursor?.lastPulledAt?.toISOString() ?? null,
          lastPushedAt: syncCursor?.lastPushedAt?.toISOString() ?? null,
        },
        latestSequence: latestSeq,
        changesBehind,
        pendingMutations,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

export const syncRoutes = app
