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

  // 3. Check for duplicate (same user, same agency, same service, same offline time, same device)
  const existing = await db.reservation.findFirst({
    where: {
      userId,
      agencyId: offlineReservation.agencyId,
      serviceId: offlineReservation.serviceId,
      offlineCreatedAt: new Date(offlineReservation.offlineCreatedAt),
      syncDeviceId: offlineReservation.syncDeviceId,
    },
  })

  if (existing) {
    return { success: false, conflict: SyncConflict.DUPLICATE }
  }

  // 4. Check if queue is full
  const activeCount = await db.reservation.count({
    where: {
      agencyId: offlineReservation.agencyId,
      serviceId: offlineReservation.serviceId,
      status: { in: ['WAITING', 'DEFERRED_OFFLINE'] },
    },
  })
  if (agency.maxActiveReservations > 0 && activeCount >= agency.maxActiveReservations) {
    return { success: false, conflict: SyncConflict.QUEUE_FULL }
  }

  // 5. Get next queue number
  const lastReservation = await db.reservation.findFirst({
    where: { agencyId: offlineReservation.agencyId, serviceId: offlineReservation.serviceId },
    orderBy: { queueNumber: 'desc' },
    select: { queueNumber: true },
  })

  const queueNumber = (lastReservation?.queueNumber || 0) + 1

  // 6. Calculate ETA
  const waitingCount = await db.reservation.count({
    where: {
      agencyId: offlineReservation.agencyId,
      serviceId: offlineReservation.serviceId,
      status: { in: ['WAITING', 'DEFERRED_OFFLINE'] },
    },
  })

  const avgServiceTime = agency.averageServiceTime || 10
  const etaMinutes = waitingCount * avgServiceTime

  // 7. Build display number (prefix + queueNumber)
  const displayNumber = `${service.prefix}${queueNumber}`

  // 8. Create the reservation — convert from DEFERRED_OFFLINE to WAITING
  const reservation = await db.reservation.create({
    data: {
      userId,
      agencyId: offlineReservation.agencyId,
      serviceId: offlineReservation.serviceId,
      queueNumber,
      displayNumber,
      status: 'WAITING',
      estimatedWait: etaMinutes,
      reservedDate: offlineReservation.reservedDate || null,
      preferredTime: offlineReservation.preferredTime || null,
      notes: offlineReservation.notes || '',
      fixedTimeEnabled: offlineReservation.fixedTimeEnabled ?? false,
      fixedTime: offlineReservation.fixedTime || null,
      offlineCreatedAt: new Date(offlineReservation.offlineCreatedAt),
      syncedAt: new Date(),
      syncDeviceId: offlineReservation.syncDeviceId,
    },
    include: {
      agency: { select: { id: true, name: true, nameFr: true, nameAr: true, customCode: true } },
      service: { select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
    },
  })

  // 9. Update queue settings lastIssuedNumber
  if (agency.queueSettings.length > 0) {
    await db.queueSettings.update({
      where: { id: agency.queueSettings[0].id },
      data: { lastIssuedNumber: queueNumber },
    })
  }

  return { success: true, reservation }
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
