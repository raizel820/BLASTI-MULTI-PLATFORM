/**
 * BLASTI Realtime Emit — Server-side helper for broadcasting Socket.IO events
 *
 * This module is used by Next.js API routes to emit real-time events
 * to the Socket.IO server (mini-service on port 3003).
 *
 * Usage in API routes:
 *   import { emitQueueEvent, emitNotificationEvent, emitReservationEvent, emitAgencyEvent, emitStaffEvent } from '@/lib/realtime-emit'
 *
 *   // After calling next ticket:
 *   await emitQueueEvent('queue:called', agencyId, { ticketNumber, customerName, serviceId })
 *
 *   // After customer joins:
 *   await emitQueueEvent('queue:joined', agencyId, { position, estimatedWait })
 *
 *   // After reservation change:
 *   await emitReservationEvent('reservation:created', agencyId, userId, { ...data })
 *
 *   // Send personal notification:
 *   await emitNotificationEvent('notification:your-turn', userId, { ticketNumber, agencyName })
 *
 *   // Agency settings update:
 *   await emitAgencyEvent('agency:updated', agencyId, { ...data })
 *
 *   // Staff change:
 *   await emitStaffEvent('staff:updated', agencyId, { ...data })
 */

const REALTIME_SERVICE_PORT = 3003
// Prefer the env var (set in .env as REALTIME_SERVICE_URL); fall back to localhost
const REALTIME_SERVICE_URL = process.env.REALTIME_SERVICE_URL || `http://localhost:${REALTIME_SERVICE_PORT}`
const REALTIME_SECRET = process.env.REALTIME_SECRET || ''

// ─── Types ─────────────────────────────────────────────────────────────────

export type QueueEventType =
  | 'queue:created'
  | 'queue:updated'
  | 'queue:called'
  | 'queue:completed'
  | 'queue:no-show'
  | 'queue:cancelled'
  | 'queue:joined'
  | 'queue:walk-in'
  | 'queue:paused'
  | 'queue:resumed'
  | 'queue:position-changed'
  | 'queue:settings-updated'

export type ReservationEventType =
  | 'reservation:created'
  | 'reservation:updated'
  | 'reservation:cancelled'

export type NotificationEventType =
  | 'notification:new'
  | 'notification:turn-approaching'
  | 'notification:your-turn'

export type KioskEventType = 'kiosk:update'

export type AgencyEventType =
  | 'agency:updated'

export type StaffEventType =
  | 'staff:updated'

export type DeviceEventType =
  | 'device:registered'

export type AdminEventType =
  | 'admin:stats-updated'
  | 'admin:user-created'

export interface QueueEventPayload {
  type: QueueEventType
  agencyId: string
  data: Record<string, unknown>
}

export interface ReservationEventPayload {
  type: ReservationEventType
  agencyId: string
  userId?: string
  data: Record<string, unknown>
}

export interface NotificationEventPayload {
  type: NotificationEventType
  userId: string
  data: Record<string, unknown>
}

export interface KioskEventPayload {
  type: KioskEventType
  agencyId: string
  data: Record<string, unknown>
}

export interface AgencyEventPayload {
  type: AgencyEventType
  agencyId: string
  data: Record<string, unknown>
}

export interface StaffEventPayload {
  type: StaffEventType
  agencyId: string
  data: Record<string, unknown>
}

export interface DeviceEventPayload {
  type: DeviceEventType
  userId: string
  data: Record<string, unknown>
}

export interface AdminEventPayload {
  type: AdminEventType
  data: Record<string, unknown>
}

// ─── Emit Functions ────────────────────────────────────────────────────────

/**
 * Emit a queue event to all clients in an agency room.
 * Used when queue state changes (call next, complete, join, pause, etc.)
 */
export async function emitQueueEvent(
  type: QueueEventType,
  agencyId: string,
  data: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (REALTIME_SECRET) {
      headers['x-internal-secret'] = REALTIME_SECRET
    }
    const response = await fetch(`${REALTIME_SERVICE_URL}/emit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type, agencyId, data }),
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch (error) {
    console.warn(`[Realtime] Failed to emit ${type} for agency ${agencyId}:`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Emit a reservation event to the agency room and optionally to a specific customer.
 */
export async function emitReservationEvent(
  type: ReservationEventType,
  agencyId: string,
  userId: string | undefined,
  data: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (REALTIME_SECRET) {
      headers['x-internal-secret'] = REALTIME_SECRET
    }
    const response = await fetch(`${REALTIME_SERVICE_URL}/emit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type, agencyId, userId, data }),
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch (error) {
    console.warn(`[Realtime] Failed to emit ${type} for agency ${agencyId}:`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Emit a notification event to a specific user.
 * Used for "your turn", "turn approaching", etc.
 */
export async function emitNotificationEvent(
  type: NotificationEventType,
  userId: string,
  data: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (REALTIME_SECRET) {
      headers['x-internal-secret'] = REALTIME_SECRET
    }
    const response = await fetch(`${REALTIME_SERVICE_URL}/emit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type, userId, data }),
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch (error) {
    console.warn(`[Realtime] Failed to emit ${type} for user ${userId}:`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Emit a kiosk update event for the kiosk display.
 * Used when the "now serving" display needs updating.
 */
export async function emitKioskEvent(
  agencyId: string,
  data: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (REALTIME_SECRET) {
      headers['x-internal-secret'] = REALTIME_SECRET
    }
    const response = await fetch(`${REALTIME_SERVICE_URL}/emit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'kiosk:update', agencyId, data }),
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch (error) {
    console.warn(`[Realtime] Failed to emit kiosk:update for agency ${agencyId}:`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Emit an agency update event to all clients in the agency room.
 * Used when agency settings, profile, or working hours change.
 */
export async function emitAgencyEvent(
  type: AgencyEventType,
  agencyId: string,
  data: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (REALTIME_SECRET) {
      headers['x-internal-secret'] = REALTIME_SECRET
    }
    const response = await fetch(`${REALTIME_SERVICE_URL}/emit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type, agencyId, data }),
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch (error) {
    console.warn(`[Realtime] Failed to emit ${type} for agency ${agencyId}:`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Emit a staff update event to all clients in the agency room.
 * Used when staff is added, removed, or permissions change.
 */
export async function emitStaffEvent(
  type: StaffEventType,
  agencyId: string,
  data: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (REALTIME_SECRET) {
      headers['x-internal-secret'] = REALTIME_SECRET
    }
    const response = await fetch(`${REALTIME_SERVICE_URL}/emit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type, agencyId, data }),
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch (error) {
    console.warn(`[Realtime] Failed to emit ${type} for agency ${agencyId}:`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Emit a device event to a specific customer room.
 * Used when a device is registered for a user.
 */
export async function emitDeviceEvent(
  type: DeviceEventType,
  userId: string,
  data: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (REALTIME_SECRET) {
      headers['x-internal-secret'] = REALTIME_SECRET
    }
    const response = await fetch(`${REALTIME_SERVICE_URL}/emit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type, userId, data }),
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch (error) {
    console.warn(`[Realtime] Failed to emit ${type} for user ${userId}:`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Emit an admin event to the admin:global room.
 * Used for admin dashboard updates.
 */
export async function emitAdminEvent(
  type: AdminEventType,
  data: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (REALTIME_SECRET) {
      headers['x-internal-secret'] = REALTIME_SECRET
    }
    const response = await fetch(`${REALTIME_SERVICE_URL}/emit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type, data }),
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch (error) {
    console.warn(`[Realtime] Failed to emit ${type}:`, error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Emit multiple events at once (batch).
 * Useful when a single action triggers multiple events.
 */
export async function emitBatch(
  events: Array<QueueEventPayload | ReservationEventPayload | NotificationEventPayload | KioskEventPayload | AgencyEventPayload | StaffEventPayload | DeviceEventPayload | AdminEventPayload>
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (REALTIME_SECRET) {
      headers['x-internal-secret'] = REALTIME_SECRET
    }
    const response = await fetch(`${REALTIME_SERVICE_URL}/emit-batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
  } catch (error) {
    console.warn('[Realtime] Failed to emit batch:', error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * Check if the realtime service is healthy.
 */
export async function isRealtimeHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${REALTIME_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}
