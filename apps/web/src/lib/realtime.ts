/**
 * BLASTI Realtime — Compatibility Wrapper
 *
 * @deprecated This module is deprecated. Use `@/lib/realtime-emit` for new code.
 *   import { emitQueueEvent, emitAgencyEvent, ... } from '@/lib/realtime-emit'
 *
 * This wrapper re-exports the typed functions from `realtime-emit.ts` so that
 * any legacy code importing from `@/lib/realtime` continues to work without
 * changes. The old `{ room, event, data }` format is NOT compatible with the
 * current realtime service; everything now goes through the typed `{ type, agencyId, data }`
 * format internally.
 */

// Re-export everything from the canonical module
export {
  // Typed emit functions
  emitQueueEvent,
  emitReservationEvent,
  emitNotificationEvent,
  emitKioskEvent,
  emitAgencyEvent,
  emitStaffEvent,
  emitDeviceEvent,
  emitAdminEvent,
  emitBatch,
  isRealtimeHealthy,

  // Types
  type QueueEventType,
  type ReservationEventType,
  type NotificationEventType,
  type KioskEventType,
  type AgencyEventType,
  type StaffEventType,
  type DeviceEventType,
  type AdminEventType,
  type QueueEventPayload,
  type ReservationEventPayload,
  type NotificationEventPayload,
  type KioskEventPayload,
  type AgencyEventPayload,
  type StaffEventPayload,
  type DeviceEventPayload,
  type AdminEventPayload,
} from '@/lib/realtime-emit'

import {
  emitQueueEvent,
  emitAgencyEvent,
  emitNotificationEvent,
  emitAdminEvent,
} from '@/lib/realtime-emit'

/**
 * @deprecated Use the typed emit functions from `@/lib/realtime-emit` instead.
 *   e.g. `emitQueueEvent('queue:updated', agencyId, data)`
 *
 * This function is kept for backward compatibility only.
 * The old `{ room, event, data }` format is converted to the new typed format
 * by inferring the correct emit function from the event name.
 */
export async function emitRealtimeEvent(room: string, event: string, data: unknown) {
  try {
    // Infer agencyId from room format "agency:<id>"
    const agencyId = room.startsWith('agency:') ? room.replace('agency:', '') : room === 'admin' ? '' : room.replace('user:', '')

    // Route to the correct typed emit function based on event prefix
    if (event.startsWith('queue:')) {
      return emitQueueEvent(event as import('@/lib/realtime-emit').QueueEventType, agencyId, data as Record<string, unknown>)
    }

    if (event.startsWith('agency:')) {
      return emitAgencyEvent(event as import('@/lib/realtime-emit').AgencyEventType, agencyId, data as Record<string, unknown>)
    }

    if (event.startsWith('notification:')) {
      // Old format: room was "user:<userId>", extract userId
      const userId = room.replace('user:', '').replace('customer:', '')
      return emitNotificationEvent(event as import('@/lib/realtime-emit').NotificationEventType, userId, data as Record<string, unknown>)
    }

    // Fallback: try queue event with the agencyId
    console.warn(`[realtime:deprecated] emitRealtimeEvent called with unknown event "${event}". Routing as queue event.`)
    return emitQueueEvent(event as import('@/lib/realtime-emit').QueueEventType, agencyId, data as Record<string, unknown>)
  } catch (error) {
    console.error('[realtime:deprecated] Failed to emit event via compatibility wrapper:', error)
  }
}

/**
 * @deprecated Use the typed emit functions from `@/lib/realtime-emit` instead.
 *
 * Convenience methods kept for backward compatibility.
 * All calls are routed through the canonical typed emit functions.
 */
export const realtime = {
  queueUpdated: (agencyId: string, data: unknown) =>
    emitQueueEvent('queue:updated', agencyId, data as Record<string, unknown>),

  positionChanged: (userId: string, data: unknown) =>
    emitQueueEvent('queue:position-changed', userId, data as Record<string, unknown>),

  turnCalled: (userId: string, data: unknown) =>
    emitQueueEvent('queue:called', userId, data as Record<string, unknown>),

  serviceCompleted: (userId: string, data: unknown) =>
    emitQueueEvent('queue:completed', userId, data as Record<string, unknown>),

  reservationCancelled: (userId: string, data: unknown) =>
    emitQueueEvent('queue:cancelled', userId, data as Record<string, unknown>),

  agencyStatsUpdated: (agencyId: string, data: unknown) =>
    emitAgencyEvent('agency:updated', agencyId, data as Record<string, unknown>),

  adminStatsUpdated: (data: unknown) =>
    emitAdminEvent('admin:stats-updated', data as Record<string, unknown>),

  adminUserCreated: (data: unknown) =>
    emitAdminEvent('admin:user-created', data as Record<string, unknown>),
}
