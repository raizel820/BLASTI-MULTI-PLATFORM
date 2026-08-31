/**
 * BLASTI Sync Routes — WatermelonDB Local-First Architecture (Phase 5)
 *
 * Provides incremental sync endpoints for pulling and pushing data
 * between local WatermelonDB clients and the central Prisma database.
 *
 * GET  /api/sync/status — Server sync status
 * POST /api/sync/pull   — Pull incremental changes since last sync
 * POST /api/sync/push   — Push local changes to the server
 */

import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, authErrorResponse, AuthError } from '../lib/auth'
import { isRealtimeHealthy } from '../lib/realtime-emit'
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
  lastPulledAt: z.string().optional(), // ISO timestamp of last successful pull
  models: z.array(z.string()).optional(), // Which models to sync (default: all)
  agencyId: z.string().optional(), // Filter to specific agency
})

// POST /api/sync/pull — Pull incremental changes since last sync
// Phase 5: Returns all records updated after lastPulledAt + deleted record tombstones
app.post('/pull', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()
    const validation = z.object({
      lastPulledAt: z.string().optional(),
      agencyId: z.string().optional(),
    }).safeParse(body)

    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid pull request', details: validation.error.errors }, 400)
    }

    const { lastPulledAt, agencyId } = validation.data
    const since = lastPulledAt ? new Date(lastPulledAt) : new Date(0) // Epoch if never synced

    // Determine which agency(s) the user has access to
    let targetAgencyId = agencyId

    if (!targetAgencyId && user.role !== 'SUPER_ADMIN') {
      // Auto-resolve to user's agency
      const staffRecord = await db.agencyStaff.findFirst({
        where: { userId: user.id, isActive: true },
        select: { agencyId: true },
      })
      const ownedAgency = await db.agency.findFirst({
        where: { ownerId: user.id },
        select: { id: true },
      })
      targetAgencyId = staffRecord?.agencyId || ownedAgency?.id || undefined
    }

    const now = new Date()
    const changes: Record<string, { created: any[]; updated: any[]; deleted: string[] }> = {}

    // Fetch changes for each sync model
    for (const model of SYNC_MODELS) {
      changes[model] = { created: [], updated: [], deleted: [] }

      // Get deleted records (tombstones)
      const deletedRecords = await db.deletedRecord.findMany({
        where: {
          modelName: model,
          deletedAt: { gte: since },
        },
        select: { recordId: true },
      })
      changes[model].deleted = deletedRecords.map(r => r.recordId)

      // Fetch created/updated records based on model type
      switch (model) {
        case 'Agency': {
          const where: any = { updatedAt: { gte: since } }
          if (targetAgencyId) where.id = targetAgencyId
          else if (user.role === 'CUSTOMER') {
            // Customers can see agencies they have reservations with
            const reservationAgencies = await db.reservation.findMany({
              where: { userId: user.id },
              select: { agencyId: true },
              distinct: ['agencyId'],
            })
            where.id = { in: reservationAgencies.map(r => r.agencyId) }
          }
          const records = await db.agency.findMany({
            where,
            select: {
              id: true, name: true, nameFr: true, nameAr: true,
              customCode: true, category: true, address: true, city: true,
              phone: true, email: true, averageServiceTime: true,
              maxActiveReservations: true, isQueueOpen: true,
              subscriptionTier: true, subscriptionStatus: true,
              workingHoursStart: true, workingHoursEnd: true,
              isActive: true, createdAt: true, updatedAt: true,
            },
          })
          // Split into created vs updated based on createdAt
          for (const record of records) {
            if (record.createdAt >= since) {
              changes[model].created.push(record)
            } else {
              changes[model].updated.push(record)
            }
          }
          break
        }

        case 'Service': {
          const where: any = { updatedAt: { gte: since }, isActive: true }
          if (targetAgencyId) where.agencyId = targetAgencyId
          const records = await db.service.findMany({
            where,
            select: {
              id: true, agencyId: true, name: true, nameFr: true, nameAr: true,
              prefix: true, isActive: true, createdAt: true, updatedAt: true,
            },
          })
          for (const record of records) {
            if (record.createdAt >= since) changes[model].created.push(record)
            else changes[model].updated.push(record)
          }
          break
        }

        case 'Branch': {
          const where: any = { updatedAt: { gte: since }, isActive: true }
          if (targetAgencyId) where.agencyId = targetAgencyId
          const records = await db.branch.findMany({
            where,
            select: {
              id: true, agencyId: true, name: true, nameAr: true, nameFr: true,
              address: true, phone: true, isMain: true, isActive: true,
              createdAt: true, updatedAt: true,
            },
          })
          for (const record of records) {
            if (record.createdAt >= since) changes[model].created.push(record)
            else changes[model].updated.push(record)
          }
          break
        }

        case 'Counter': {
          const where: any = { updatedAt: { gte: since }, isActive: true }
          if (targetAgencyId) {
            where.branch = { agencyId: targetAgencyId }
          }
          const records = await db.counter.findMany({
            where,
            select: {
              id: true, branchId: true, number: true, name: true,
              nameAr: true, nameFr: true, isActive: true,
              createdAt: true, updatedAt: true,
            },
          })
          for (const record of records) {
            if (record.createdAt >= since) changes[model].created.push(record)
            else changes[model].updated.push(record)
          }
          break
        }

        case 'Reservation': {
          const where: any = { updatedAt: { gte: since } }
          if (targetAgencyId) {
            where.agencyId = targetAgencyId
          } else if (user.role === 'CUSTOMER') {
            where.userId = user.id
          }
          const records = await db.reservation.findMany({
            where,
            select: {
              id: true, userId: true, agencyId: true, serviceId: true,
              queueNumber: true, displayNumber: true, status: true,
              estimatedWait: true, joinedAt: true, calledAt: true,
              completedAt: true, cancelledAt: true, preferredTime: true,
              fixedTimeEnabled: true, postponeCount: true, isWalkIn: true,
              walkInCustomerName: true, counterId: true,
              createdAt: true, updatedAt: true,
            },
            take: 500, // Limit batch size
            orderBy: { updatedAt: 'asc' },
          })
          for (const record of records) {
            if (record.createdAt >= since) changes[model].created.push(record)
            else changes[model].updated.push(record)
          }
          break
        }

        case 'Notification': {
          const where: any = { createdAt: { gte: since }, userId: user.id }
          const records = await db.notification.findMany({
            where,
            select: {
              id: true, userId: true, type: true, title: true,
              message: true, isRead: true, entityId: true, createdAt: true,
            },
            take: 200,
            orderBy: { createdAt: 'desc' },
          })
          changes[model].created = records // Notifications are never "updated"
          break
        }

        case 'QueueSettings': {
          const where: any = { updatedAt: { gte: since } }
          if (targetAgencyId) where.agencyId = targetAgencyId
          const records = await db.queueSettings.findMany({
            where,
            select: {
              id: true, agencyId: true, currentServingNumber: true,
              lastIssuedNumber: true, isPaused: true, pausedAt: true,
              updatedAt: true,
            },
          })
          for (const record of records) {
            changes[model].updated.push(record) // Queue settings are always updates
          }
          break
        }
      }
    }

    return c.json({
      success: true,
      timestamp: now.toISOString(),
      changes,
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

// ─── Push Schema ────────────────────────────────────────────────────────────

const pushSchema = z.object({
  changes: z.record(z.any()),
  lastPulledAt: z.string().optional(),
})

// POST /api/sync/push — Push local changes to the server
// Phase 5: Accepts changes from WatermelonDB clients
// Phase 4a: Enforces role-based push permissions via ALLOWED_PUSH_PER_ROLE
app.post('/push', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()

    const validation = pushSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid push request', details: validation.error.errors }, 400)
    }

    const { changes } = validation.data
    const results: Record<string, { created: number; updated: number; deleted: number; skipped?: string }> = {}

    // Phase 4a: Resolve the user's role for permission checks
    const userRole = user.role as string
    const rolePermissions = ALLOWED_PUSH_PER_ROLE[userRole]

    // Process each model's changes
    for (const [modelName, modelChanges] of Object.entries(changes)) {
      if (!SYNC_MODELS.includes(modelName as SyncModel)) continue

      const mc = modelChanges as { created?: any[]; updated?: any[]; deleted?: string[] }
      results[modelName] = { created: 0, updated: 0, deleted: 0 }

      // Phase 4a: Check if this model is allowed for the user's role
      if (!rolePermissions || !rolePermissions[modelName]) {
        // Model not in user's allowed list — skip entirely
        console.warn(`[SYNC] User role ${userRole} attempted push to ${modelName} — skipped (not allowed)`)
        results[modelName].skipped = 'Model not allowed for role'
        continue
      }

      const modelPerms = rolePermissions[modelName]

      // Process creates
      if (mc.created && Array.isArray(mc.created)) {
        if (!modelPerms.create) {
          // Create not allowed for this role+model combination
          if (mc.created.length > 0) {
            console.warn(`[SYNC] User role ${userRole} attempted create on ${modelName} — skipped (not allowed)`)
            results[modelName].skipped = 'Create not allowed for role'
          }
        } else {
          for (const record of mc.created) {
            try {
              // Only allow creating reservations that belong to the user
              if (modelName === 'Reservation' && record.userId === user.id) {
                await db.reservation.upsert({
                  where: { id: record.id },
                  create: {
                    id: record.id,
                    userId: record.userId,
                    agencyId: record.agencyId,
                    serviceId: record.serviceId,
                    queueNumber: record.queueNumber,
                    displayNumber: record.displayNumber,
                    status: record.status || 'WAITING',
                    estimatedWait: record.estimatedWait,
                    preferredTime: record.preferredTime,
                    fixedTimeEnabled: record.fixedTimeEnabled ?? false,
                    isWalkIn: record.isWalkIn ?? false,
                    walkInCustomerName: record.walkInCustomerName,
                  },
                  update: {},
                })
                results[modelName].created++
              } else if (modelName === 'Service') {
                await db.service.upsert({
                  where: { id: record.id },
                  create: {
                    id: record.id,
                    agencyId: record.agencyId,
                    name: record.name,
                    nameFr: record.nameFr,
                    nameAr: record.nameAr,
                    prefix: record.prefix,
                    isActive: record.isActive ?? true,
                  },
                  update: {},
                })
                results[modelName].created++
              } else if (modelName === 'Branch') {
                await db.branch.upsert({
                  where: { id: record.id },
                  create: {
                    id: record.id,
                    agencyId: record.agencyId,
                    name: record.name,
                    nameAr: record.nameAr,
                    nameFr: record.nameFr,
                    address: record.address,
                    phone: record.phone,
                    isActive: record.isActive ?? true,
                  },
                  update: {},
                })
                results[modelName].created++
              } else if (modelName === 'Counter') {
                await db.counter.upsert({
                  where: { id: record.id },
                  create: {
                    id: record.id,
                    branchId: record.branchId,
                    name: record.name,
                    nameAr: record.nameAr,
                    nameFr: record.nameFr,
                    isActive: record.isActive ?? true,
                  },
                  update: {},
                })
                results[modelName].created++
              } else if (modelName === 'Notification') {
                await db.notification.upsert({
                  where: { id: record.id },
                  create: {
                    id: record.id,
                    userId: record.userId || user.id,
                    type: record.type,
                    title: record.title,
                    message: record.message,
                    isRead: record.isRead ?? false,
                  },
                  update: {},
                })
                results[modelName].created++
              } else if (modelName === 'QueueSettings') {
                await db.queueSettings.upsert({
                  where: { id: record.id },
                  create: {
                    id: record.id,
                    agencyId: record.agencyId,
                    currentServingNumber: record.currentServingNumber ?? 0,
                    lastIssuedNumber: record.lastIssuedNumber ?? 0,
                    isPaused: record.isPaused ?? false,
                  },
                  update: {},
                })
                results[modelName].created++
              }
            } catch (err) {
              console.warn(`[SYNC] Failed to create ${modelName}:`, err)
            }
          }
        }
      }

      // Process updates — Phase 4a: Only allow specified fields per role
      if (mc.updated && Array.isArray(mc.updated)) {
        const allowedUpdateFields = modelPerms.update
        for (const record of mc.updated) {
          try {
            // Filter record to only include allowed update fields
            const filteredData: Record<string, unknown> = {}
            for (const field of allowedUpdateFields) {
              if (field in record) {
                filteredData[field] = record[field]
              }
            }

            if (Object.keys(filteredData).length === 0) {
              // No allowed fields in the update — skip
              continue
            }

            if (modelName === 'Reservation') {
              // Customers can only update their own reservations
              const whereClause: Record<string, unknown> = { id: record.id }
              if (userRole === 'CUSTOMER') {
                whereClause.userId = user.id
              }
              await db.reservation.updateMany({
                where: whereClause,
                data: filteredData,
              })
              results[modelName].updated++
            } else if (modelName === 'Notification') {
              // Users can only update their own notifications
              await db.notification.updateMany({
                where: { id: record.id, userId: user.id },
                data: filteredData,
              })
              results[modelName].updated++
            } else if (modelName === 'Service') {
              await db.service.updateMany({
                where: { id: record.id },
                data: filteredData,
              })
              results[modelName].updated++
            } else if (modelName === 'Branch') {
              await db.branch.updateMany({
                where: { id: record.id },
                data: filteredData,
              })
              results[modelName].updated++
            } else if (modelName === 'Counter') {
              await db.counter.updateMany({
                where: { id: record.id },
                data: filteredData,
              })
              results[modelName].updated++
            } else if (modelName === 'QueueSettings') {
              await db.queueSettings.updateMany({
                where: { id: record.id },
                data: filteredData,
              })
              results[modelName].updated++
            } else if (modelName === 'Agency') {
              await db.agency.updateMany({
                where: { id: record.id },
                data: filteredData,
              })
              results[modelName].updated++
            }
          } catch (err) {
            console.warn(`[SYNC] Failed to update ${modelName}:`, err)
          }
        }
      }

      // Process deletes — Phase 4a: Only if delete is allowed for role+model
      if (mc.deleted && Array.isArray(mc.deleted)) {
        if (!modelPerms.delete) {
          // Delete not allowed for this role+model combination
          if (mc.deleted.length > 0) {
            console.warn(`[SYNC] User role ${userRole} attempted delete on ${modelName} — skipped (not allowed)`)
            results[modelName].skipped = 'Delete not allowed for role'
          }
        } else {
          for (const recordId of mc.deleted) {
            try {
              await db.deletedRecord.upsert({
                where: { id: `${modelName}:${recordId}` },
                create: {
                  id: `${modelName}:${recordId}`,
                  modelName,
                  recordId,
                },
                update: {},
              })
              results[modelName].deleted++
            } catch (err) {
              console.warn(`[SYNC] Failed to delete ${modelName}:`, err)
            }
          }
        }
      }
    }

    return c.json({ success: true, results })
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      const err = authErrorResponse(error)
      return c.json({ success: err.success, error: err.error }, err.status as any)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// GET /api/sync/status — Server sync status endpoint
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
      syncProtocolVersion: 1,
    }

    if (!agencyId) {
      return c.json({ success: true, ...baseResponse, agency: null })
    }

    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      select: { id: true },
    })

    if (!agency) {
      return c.json({ success: true, ...baseResponse, agency: null })
    }

    const lastSyncTime = agencyLastSync.get(agencyId)

    const [currentWaiting, currentCalled, queueSettings, latestReservation] = await Promise.all([
      db.reservation.count({ where: { agencyId, status: 'WAITING' } }),
      db.reservation.count({ where: { agencyId, status: 'CALLED' } }),
      db.queueSettings.findFirst({ where: { agencyId }, select: { updatedAt: true, isPaused: true } }),
      db.reservation.findFirst({ where: { agencyId }, orderBy: { joinedAt: 'desc' }, select: { joinedAt: true } }),
    ])

    let effectiveLastSync: Date | null = lastSyncTime || null
    if (queueSettings?.updatedAt && (!effectiveLastSync || queueSettings.updatedAt > effectiveLastSync)) {
      effectiveLastSync = queueSettings.updatedAt
    }
    if (latestReservation?.joinedAt && (!effectiveLastSync || latestReservation.joinedAt > effectiveLastSync)) {
      effectiveLastSync = latestReservation.joinedAt
    }

    const totalPendingEvents = currentWaiting + currentCalled

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
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

export const syncRoutes = app
