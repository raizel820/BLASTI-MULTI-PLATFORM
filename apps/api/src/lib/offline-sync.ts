/**
 * @blasti/api — Offline Sync Bridge
 *
 * Handles conversion of offline reservations (created while the device
 * had no internet) to real WAITING reservations on the server.
 *
 * Flow:
 *   1. Client creates reservation locally with DEFERRED_OFFLINE status
 *   2. When connectivity returns, client POSTs the offline reservation here
 *   3. Bridge validates (agency/service existence, activity, duplicates)
 *   4. Bridge creates a real WAITING reservation with sync metadata
 *   5. Cron sweeper cleans up stale DEFERRED_OFFLINE reservations > 24h
 */

import { db } from '@blasti/db'
import { todayLocalDateString } from './queue-waiting'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OfflineReservation {
  agencyId: string
  serviceId: string
  customerName?: string
  customerPhone?: string
  offlineCreatedAt: string
  syncDeviceId: string
  notes?: string
  fixedTimeEnabled?: boolean
  fixedTime?: string
  reservedDate?: string
  preferredTime?: string
}

export interface SyncResult {
  success: boolean
  reservation?: any
  conflict?: string
}

export interface BatchSyncResult {
  synced: number
  conflicts: number
  errors: string[]
}

// ─── Conflict Types ─────────────────────────────────────────────────────────

export const SyncConflict = {
  AGENCY_NOT_FOUND: 'AGENCY_NOT_FOUND',
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  SERVICE_INACTIVE: 'SERVICE_INACTIVE',
  AGENCY_INACTIVE: 'AGENCY_INACTIVE',
  QUEUE_PAUSED: 'QUEUE_PAUSED',
  DUPLICATE: 'DUPLICATE',
  QUEUE_FULL: 'QUEUE_FULL',
} as const

// ─── Single Reservation Sync ────────────────────────────────────────────────

export async function syncOfflineReservation(
  offlineReservation: OfflineReservation,
  userId: string
): Promise<SyncResult> {
  // 1. Validate agency and service
  const agency = await db.agency.findUnique({
    where: { id: offlineReservation.agencyId },
    include: {
      services: { where: { id: offlineReservation.serviceId } },
      queueSettings: { take: 1 },
    },
  })

  if (!agency) {
    return { success: false, conflict: SyncConflict.AGENCY_NOT_FOUND }
  }

  if (!agency.isActive) {
    return { success: false, conflict: SyncConflict.AGENCY_INACTIVE }
  }

  if (agency.services.length === 0) {
    return { success: false, conflict: SyncConflict.SERVICE_NOT_FOUND }
  }

  const service = agency.services[0]

  if (!service.isActive) {
    return { success: false, conflict: SyncConflict.SERVICE_INACTIVE }
  }

  // 2. Check queue is not paused
  if (agency.queueSettings.length > 0 && agency.queueSettings[0].isPaused) {
    return { success: false, conflict: SyncConflict.QUEUE_PAUSED }
  }

  // P0-4: the ENTIRE deferred-reservation conversion (dup check → capacity
  // check → allocator → create → lastIssuedNumber) is now ONE $transaction.
  // Previously every step was a separate top-level write: two devices syncing
  // concurrently could BOTH pass the dup check and BOTH allocate the same
  // queueNumber; a crash mid-flow could decrement nothing but still create.
  // The serviceId+reservedDate+queueNumber unique constraint is the final
  // backstop — a P2002 here surfaces as an explicit DUPLICATE conflict.
  try {
    return await db.$transaction(async (tx) => {
      // 3. Duplicate (same user, same agency, same service, same offline time, same device)
      const existing = await tx.reservation.findFirst({
        where: {
          userId,
          agencyId: offlineReservation.agencyId,
          serviceId: offlineReservation.serviceId,
          offlineCreatedAt: new Date(offlineReservation.offlineCreatedAt),
          syncDeviceId: offlineReservation.syncDeviceId,
        },
      })
      if (existing) {
        return { success: false as const, conflict: SyncConflict.DUPLICATE }
      }

      // 4. Capacity
      const activeCount = await tx.reservation.count({
        where: {
          agencyId: offlineReservation.agencyId,
          serviceId: offlineReservation.serviceId,
          status: { in: ['WAITING', 'DEFERRED_OFFLINE'] },
        },
      })
      if (agency.maxActiveReservations > 0 && activeCount >= agency.maxActiveReservations) {
        return { success: false as const, conflict: SyncConflict.QUEUE_FULL }
      }

      // 5. Next queue number
      const lastReservation = await tx.reservation.findFirst({
        where: { agencyId: offlineReservation.agencyId, serviceId: offlineReservation.serviceId },
        orderBy: { queueNumber: 'desc' },
        select: { queueNumber: true },
      })
      const queueNumber = (lastReservation?.queueNumber || 0) + 1

      // 6. ETA
      const waitingCount = await tx.reservation.count({
        where: {
          agencyId: offlineReservation.agencyId,
          serviceId: offlineReservation.serviceId,
          status: { in: ['WAITING', 'DEFERRED_OFFLINE'] },
        },
      })
      // P2-10 — owner-set per-service duration overrides the agency average.
      const avgServiceTime =
        service.durationMinutes != null && service.durationMinutes > 0
          ? service.durationMinutes
          : (agency.averageServiceTime || 10)
      const etaMinutes = waitingCount * avgServiceTime

      // 7. Display number
      const displayNumber = `${service.prefix}${queueNumber}`

      // 8. Create — DEFERRED_OFFLINE → WAITING.
      // P0-4 fix (latent 500): `fixedTime` was never a schema column — Prisma
      // threw on every create here. The offline intent is preserved via
      // preferredTime + fixedTimeEnabled only.
      const reservedDate =
        offlineReservation.reservedDate || todayLocalDateString(new Date())
      const reservation = await tx.reservation.create({
        data: {
          userId,
          agencyId: offlineReservation.agencyId,
          serviceId: offlineReservation.serviceId,
          queueNumber,
          displayNumber,
          status: 'WAITING',
          estimatedWait: etaMinutes,
          reservedDate,
          preferredTime: offlineReservation.preferredTime || null,
          notes: offlineReservation.notes || '',
          fixedTimeEnabled: offlineReservation.fixedTimeEnabled ?? false,
          offlineCreatedAt: new Date(offlineReservation.offlineCreatedAt),
          syncedAt: new Date(),
          syncDeviceId: offlineReservation.syncDeviceId,
        },
        include: {
          agency: { select: { id: true, name: true, nameFr: true, nameAr: true, customCode: true } },
          service: { select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
        },
      })

      // 9. lastIssuedNumber
      if (agency.queueSettings.length > 0) {
        await tx.queueSettings.update({
          where: { id: agency.queueSettings[0].id },
          data: { lastIssuedNumber: queueNumber },
        })
      }

      return { success: true as const, reservation }
    })
  } catch (e: unknown) {
    // P0-4: the unique constraint is the authoritative backstop — a lost race
    // on the same (service, date, queueNumber) reports as DUPLICATE.
    if (
      typeof e === 'object' && e !== null && 'code' in e &&
      (e as { code?: string }).code === 'P2002'
    ) {
      return { success: false as const, conflict: SyncConflict.DUPLICATE }
    }
    throw e
  }
}

// ─── Batch Sync ─────────────────────────────────────────────────────────────

export async function syncOfflineBatch(
  reservations: OfflineReservation[],
  userId: string
): Promise<BatchSyncResult> {
  let synced = 0
  let conflicts = 0
  const errors: string[] = []

  for (const res of reservations) {
    const result = await syncOfflineReservation(res, userId)
    if (result.success) {
      synced++
    } else if (result.conflict) {
      conflicts++
      errors.push(result.conflict)
    }
  }

  return { synced, conflicts, errors }
}

// ─── Device Sync Status ─────────────────────────────────────────────────────

export async function getDeviceSyncStatus(
  deviceId: string,
  userId: string
): Promise<{
  pendingCount: number
  syncedCount: number
  conflictCount: number
  lastSyncAt: Date | null
}> {
  const [pending, synced, conflicted] = await Promise.all([
    db.reservation.count({
      where: {
        syncDeviceId: deviceId,
        userId,
        status: 'DEFERRED_OFFLINE',
      },
    }),
    db.reservation.count({
      where: {
        syncDeviceId: deviceId,
        userId,
        syncedAt: { not: null },
      },
    }),
    db.reservation.count({
      where: {
        syncDeviceId: deviceId,
        userId,
        syncConflict: true,
      },
    }),
  ])

  const lastSynced = await db.reservation.findFirst({
    where: {
      syncDeviceId: deviceId,
      userId,
      syncedAt: { not: null },
    },
    orderBy: { syncedAt: 'desc' },
    select: { syncedAt: true },
  })

  return {
    pendingCount: pending,
    syncedCount: synced,
    conflictCount: conflicted,
    lastSyncAt: lastSynced?.syncedAt ?? null,
  }
}
