/**
 * BLASTI WatermelonDB Offline Layer
 *
 * Replaces the legacy IndexedDB-based offline-queue.ts and offline-cache.ts.
 * Uses dynamic imports for all WatermelonDB code to avoid SSR bundling issues.
 */

'use client';

import { syncEngine } from '@/db/sync';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OfflineMutationResult {
  success: boolean;
  offline: boolean;
  message: string;
  recordId?: string;
}

export interface OfflineQueryResult<T> {
  data: T | null;
  found: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const isBrowser = typeof window !== 'undefined';

/**
 * Get the WatermelonDB database instance (client-only).
 * Uses dynamic import to avoid bundling browser-only LokiJS adapter for SSR.
 */
async function getDB(): Promise<any | null> {
  if (!isBrowser) return null;
  const { initDatabase } = await import('@/db/client-database');
  // CRITICAL FIX: Use initDatabase() (async, awaits initialization) instead of
  // getDatabase() (sync, returned null when called before init completed).
  return initDatabase();
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function getDeviceId(): string {
  if (!isBrowser) return 'server';
  try {
    let deviceId = localStorage.getItem('blasti-device-id');
    if (!deviceId) {
      deviceId = `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('blasti-device-id', deviceId);
    }
    return deviceId;
  } catch {
    return `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ─── Offline Mutation: Create Reservation ───────────────────────────────────

export async function createOfflineReservation(data: {
  agencyId: string;
  serviceId: string;
  userId?: string;
  customerName?: string;
  customerPhone?: string;
  notes?: string;
  fixedTimeEnabled?: boolean;
  fixedTime?: string;
  reservedDate?: string;
  preferredTime?: string;
}): Promise<OfflineMutationResult> {
  const db = await getDB();
  if (!db) {
    return { success: false, offline: false, message: 'Database not available' };
  }

  try {
    const now = Date.now();
    const recordId = generateId();
    const deviceId = getDeviceId();

    await db.write(async () => {
      await db.get('reservations').create((record: any) => {
        record._raw.id = recordId;
        record.userId = data.userId || null;
        record.agencyId = data.agencyId;
        record.serviceId = data.serviceId;
        record.status = 'WAITING';
        record.queueNumber = 0;
        record.displayNumber = 'PENDING';
        record.estimatedWait = 0;
        record.fixedTimeEnabled = data.fixedTimeEnabled || false;
        record.postponeCount = 0;
        record.isWalkIn = !data.userId;
        record.walkInCustomerName = data.customerName || null;
        record.preferredTime = data.preferredTime || null;
        record.syncDeviceId = deviceId;
        record.offlineCreatedAt = new Date().toISOString();
        record._raw.joined_at = now;
      });
    });

    console.log('[OfflineLayer] Created offline reservation:', recordId);

    // Auto-sync: only attempt when NOT in both-unreachable state.
    // navigator.onLine reports OS network state, not actual API reachability.
    // In Electron, the app could have a local network but no internet —
    // navigator.onLine would be true, causing a wasteful sync attempt.
    if (isBrowser) {
      // Dynamic import to avoid circular dependency
      const { isBothUnreachable } = await import('./api-client');
      if (!isBothUnreachable()) {
        syncEngine.sync(db).catch((err: any) => {
          console.warn('[OfflineLayer] Auto-sync failed:', err);
        });
      }
    }

    return {
      success: true,
      offline: true,
      message: 'Reservation created offline — will sync when online',
      recordId,
    };
  } catch (error) {
    console.error('[OfflineLayer] Failed to create offline reservation:', error);
    return {
      success: false,
      offline: true,
      message: error instanceof Error ? error.message : 'Failed to create offline reservation',
    };
  }
}

// ─── Offline Query: Get Reservations ────────────────────────────────────────

export async function getOfflineReservations(
  filters: { agencyId?: string; userId?: string; status?: string } = {},
): Promise<OfflineQueryResult<any[]>> {
  const db = await getDB();
  if (!db) return { data: null, found: false };

  try {
    const { Q } = await import('@nozbe/watermelondb');
    const conditions: any[] = [];
    if (filters.agencyId) conditions.push(Q.where('agency_id', filters.agencyId));
    if (filters.userId) conditions.push(Q.where('user_id', filters.userId));
    if (filters.status) conditions.push(Q.where('status', filters.status));

    const query =
      conditions.length > 0
        ? db.get('reservations').query(Q.and(...conditions))
        : db.get('reservations').query();

    const records = await query.fetch();
    const data = records.map((record: any) => ({
      id: record.id,
      userId: record.userId,
      agencyId: record.agencyId,
      serviceId: record.serviceId,
      queueNumber: record.queueNumber,
      displayNumber: record.displayNumber,
      status: record.status,
      estimatedWait: record.estimatedWait,
      joinedAt: record.joinedAt ? new Date(record.joinedAt).toISOString() : null,
      calledAt: record.calledAt ? new Date(record.calledAt).toISOString() : null,
      completedAt: record.completedAt ? new Date(record.completedAt).toISOString() : null,
      cancelledAt: record.cancelledAt ? new Date(record.cancelledAt).toISOString() : null,
      preferredTime: record.preferredTime,
      fixedTimeEnabled: record.fixedTimeEnabled,
      postponeCount: record.postponeCount,
      isWalkIn: record.isWalkIn,
      walkInCustomerName: record.walkInCustomerName,
      counterId: record.counterId,
      offlineCreatedAt: record.offlineCreatedAt,
    }));

    return { data, found: data.length > 0 };
  } catch (error) {
    console.error('[OfflineLayer] Failed to query offline reservations:', error);
    return { data: null, found: false };
  }
}

// ─── Offline Query: Get Agencies ────────────────────────────────────────────

export async function getOfflineAgencies(): Promise<OfflineQueryResult<any[]>> {
  const db = await getDB();
  if (!db) return { data: null, found: false };

  try {
    const records = await db.get('agencies').query().fetch();
    const data = records.map((record: any) => ({
      id: record.id,
      name: record.name,
      nameFr: record.nameFr,
      nameAr: record.nameAr,
      customCode: record.customCode,
      category: record.category,
      address: record.address,
      city: record.city,
      phone: record.phone,
      email: record.email,
      averageServiceTime: record.averageServiceTime,
      maxActiveReservations: record.maxActiveReservations,
      isQueueOpen: record.isQueueOpen,
      subscriptionTier: record.subscriptionTier,
      subscriptionStatus: record.subscriptionStatus,
      workingHoursStart: record.workingHoursStart,
      workingHoursEnd: record.workingHoursEnd,
      isActive: record.isActive,
    }));

    return { data, found: data.length > 0 };
  } catch (error) {
    console.error('[OfflineLayer] Failed to query offline agencies:', error);
    return { data: null, found: false };
  }
}

// ─── Offline Query: Get Services ────────────────────────────────────────────

export async function getOfflineServices(agencyId?: string): Promise<OfflineQueryResult<any[]>> {
  const db = await getDB();
  if (!db) return { data: null, found: false };

  try {
    const { Q } = await import('@nozbe/watermelondb');
    const query = agencyId
      ? db.get('services').query(Q.where('agency_id', agencyId))
      : db.get('services').query();

    const records = await query.fetch();
    const data = records.map((record: any) => ({
      id: record.id,
      agencyId: record.agencyId,
      name: record.name,
      nameFr: record.nameFr,
      nameAr: record.nameAr,
      prefix: record.prefix,
      isActive: record.isActive,
    }));

    return { data, found: data.length > 0 };
  } catch (error) {
    console.error('[OfflineLayer] Failed to query offline services:', error);
    return { data: null, found: false };
  }
}

// ─── Offline Mutation: Update Reservation Status ───────────────────────────

export async function updateOfflineReservationStatus(
  reservationId: string,
  status: string,
  additionalData: { counterId?: string; calledAt?: Date; completedAt?: Date; cancelledAt?: Date } = {},
): Promise<OfflineMutationResult> {
  const db = await getDB();
  if (!db) {
    return { success: false, offline: false, message: 'Database not available' };
  }

  try {
    await db.write(async () => {
      const record: any = await db.get('reservations').find(reservationId);
      await record.update((r: any) => {
        r.status = status;
        if (additionalData.counterId) r.counterId = additionalData.counterId;
        if (additionalData.calledAt) r.calledAt = additionalData.calledAt.getTime();
        if (additionalData.completedAt) r.completedAt = additionalData.completedAt.getTime();
        if (additionalData.cancelledAt) r.cancelledAt = additionalData.cancelledAt.getTime();
      });
    });

    if (isBrowser) {
      // Dynamic import to avoid circular dependency
      const { isBothUnreachable } = await import('./api-client');
      if (!isBothUnreachable()) {
        syncEngine.sync(db).catch((err: any) => {
          console.warn('[OfflineLayer] Auto-sync failed:', err);
        });
      }
    }

    return {
      success: true,
      offline: true,
      message: 'Reservation updated offline — will sync when online',
      recordId: reservationId,
    };
  } catch (error) {
    console.warn('[OfflineLayer] Could not update offline reservation:', error);
    return {
      success: false,
      offline: true,
      message: 'Reservation not found locally — cannot update offline',
    };
  }
}

// ─── Offline Stats ──────────────────────────────────────────────────────────

export async function getOfflineStats(): Promise<{
  pendingReservations: number;
  totalReservations: number;
  lastSync: string | null;
}> {
  const db = await getDB();
  if (!db) return { pendingReservations: 0, totalReservations: 0, lastSync: null };

  try {
    const { Q } = await import('@nozbe/watermelondb');
    const pending = await db.get('reservations')
      .query(Q.where('_status', Q.oneOf(['created', 'updated'])))
      .fetchCount();

    const total = await db.get('reservations').query().fetchCount();

    return {
      pendingReservations: pending,
      totalReservations: total,
      lastSync: syncEngine.getLastSyncTimestamp(),
    };
  } catch (error) {
    console.error('[OfflineLayer] Failed to get offline stats:', error);
    return { pendingReservations: 0, totalReservations: 0, lastSync: null };
  }
}

/**
 * Get queue status from local WatermelonDB cache for offline display.
 * Returns waiting/called/serving/completed counts + waiting/called lists.
 */
export async function getOfflineQueueStatus(agencyId: string) {
  const db = await getDB();
  if (!db) return null;

  try {
    const { Q } = await import('@nozbe/watermelondb');
    const reservations = await db.get('reservations')
      .query(Q.where('agency_id', agencyId))
      .fetch();

    const waiting = reservations.filter((r: any) => r.status === 'WAITING');
    const called = reservations.filter((r: any) => r.status === 'CALLED');
    const serving = reservations.filter((r: any) => r.status === 'SERVING');
    const completed = reservations.filter((r: any) => r.status === 'COMPLETED');
    const cancelled = reservations.filter((r: any) => r.status === 'CANCELLED');

    return {
      waiting: waiting.length,
      called: called.length,
      serving: serving.length,
      completed: completed.length,
      cancelled: cancelled.length,
      total: reservations.length,
      waitingList: waiting.map((r: any) => ({
        id: r.id,
        queueNumber: r.queueNumber || r.ticketNumber,
        displayName: r.displayName || r.walkInCustomerName,
        serviceName: r.serviceName,
        joinedAt: r.joinedAt,
      })),
      calledList: called.map((r: any) => ({
        id: r.id,
        queueNumber: r.queueNumber || r.ticketNumber,
        displayName: r.displayName || r.walkInCustomerName,
        serviceName: r.serviceName,
        counterId: r.counterId,
        calledAt: r.calledAt,
      })),
    };
  } catch (error) {
    console.error('[OfflineLayer] Failed to get offline queue status:', error);
    return null;
  }
}

/**
 * Get cached notifications from WatermelonDB for offline display.
 */
export async function getOfflineNotifications(userId?: string): Promise<OfflineQueryResult<any[]>> {
  const db = await getDB();
  if (!db) return { data: null, found: false };

  try {
    const { Q } = await import('@nozbe/watermelondb');
    const query = userId
      ? db.get('notifications').query(Q.where('user_id', userId))
      : db.get('notifications').query();

    const records = await query.fetch();
    const data = records.map((record: any) => ({
      id: record.id,
      type: record.type,
      title: record.title,
      message: record.message || record.body,
      isRead: record.isRead,
      createdAt: record.createdAt,
      userId: record.userId,
    }));

    return { data, found: data.length > 0 };
  } catch (error) {
    console.error('[OfflineLayer] Failed to get offline notifications:', error);
    return { data: null, found: false };
  }
}

/**
 * Get cached branches from WatermelonDB for offline display.
 */
export async function getOfflineBranches(agencyId: string) {
  const db = await getDB();
  if (!db) return null;

  try {
    const { Q } = await import('@nozbe/watermelondb');
    return await db.get('branches')
      .query(Q.where('agency_id', agencyId))
      .fetch();
  } catch (error) {
    console.error('[OfflineLayer] Failed to get offline branches:', error);
    return null;
  }
}
