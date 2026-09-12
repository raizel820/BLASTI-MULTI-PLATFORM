/**
 * use-realtime.tsx — Desktop polling-only stub (v2 hooks)
 *
 * On Desktop, real-time updates are handled via HTTP polling against the local API.
 * Socket.IO integration will come in a later iteration.
 *
 * Provides the same API surface as the Web's use-realtime.tsx but with no-op
 * implementations so that components importing these hooks compile and run
 * without errors.
 */

import { useState } from 'react';

// ─── Types ─────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

export interface RealtimeEventData {
  type: string;
  agencyId?: string;
  userId?: string;
  data: Record<string, unknown>;
  timestamp: number;
}

// ─── Low-level hook ─────────────────────────────────────────────────────────

const noop = () => {};
const noopUnsub = () => {};

/**
 * useRealtime — Desktop polling-only stub
 *
 * Returns a no-op realtime interface. All room management, event subscriptions,
 * and emissions are no-ops. `connected` is always false.
 */
export function useRealtime() {
  return {
    // Connection state
    connected: false as const,
    isConnected: false as const,  // Alias for Web component compatibility
    connectionStatus: 'disconnected' as ConnectionStatus,

    // Room management — no-ops
    joinRoom: noop as (room: string) => void,
    leaveRoom: noop as (room: string) => void,
    joinAgency: noop as (agencyId: string) => void,
    leaveAgency: noop as (agencyId: string) => void,
    joinCustomer: noop as (userId: string) => void,
    leaveCustomer: noop as (userId: string) => void,
    joinKiosk: noop as (agencyId: string) => void,
    leaveKiosk: noop as (agencyId: string) => void,
    joinAdmin: noop as () => void,
    leaveAdmin: noop as () => void,

    // Event methods — no-ops
    on: noopUnsub as (event: string, handler: (...args: unknown[]) => void) => () => void,
    off: noop as (event: string, handler: (...args: unknown[]) => void) => void,
    emit: noop as (event: string, ...args: unknown[]) => void,

    // Generic subscribe — no-op
    subscribe: noopUnsub as (event: string, handler: (...args: unknown[]) => void) => () => void,
    unsubscribe: noop as (event: string, handler: (...args: unknown[]) => void) => void,
  };
}

// ─── Agency realtime hook (v2) ──────────────────────────────────────────────

/**
 * useAgencyRealtime — Desktop polling-only stub
 *
 * Returns a no-op hook. On Desktop, agency staff receive updates
 * via polling (useNotifications, useApi with usePolling).
 */
export function useAgencyRealtime(_agencyId?: string) {
  const [lastEvent] = useState<RealtimeEventData | null>(null);

  return {
    lastEvent,
    connected: false as const,
    connectionStatus: 'disconnected' as ConnectionStatus,

    // Convenience event subscriptions — no-ops
    onQueueCreated: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
    onQueueCalled: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
    onQueueUpdated: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
    onQueueCompleted: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
    onAgencyUpdated: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
    onStaffUpdated: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
  };
}

// ─── Customer realtime hook (v2) ────────────────────────────────────────────

/**
 * useCustomerRealtime — Desktop polling-only stub
 *
 * Returns a no-op hook. On Desktop, customers receive updates
 * via polling (useNotifications, useApi with usePolling).
 */
export function useCustomerRealtime(_userId?: string) {
  const [lastEvent] = useState<RealtimeEventData | null>(null);

  return {
    lastEvent,
    connected: false as const,
    connectionStatus: 'disconnected' as ConnectionStatus,

    // Convenience event subscriptions — no-ops
    onNotification: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
    onYourTurn: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
    onTurnApproaching: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
    onReservationCreated: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
    onReservationUpdated: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
    onQueueJoined: noopUnsub as (handler: (e: RealtimeEventData) => void) => () => void,
  };
}

// ─── Turn alert hook (v2) ───────────────────────────────────────────────────

/**
 * useTurnAlert — Desktop polling-only stub
 *
 * Turn alerts on Desktop are handled via polling (useNotifications).
 * Full Socket.IO integration comes later.
 */
export function useTurnAlert(_userId: string | undefined) {
  return {
    showTurnAlert: false as const,
    turnAlertData: null as {
      reservationId?: string;
      ticketNumber: string;
      agencyName: string;
    } | null,
    dismissTurnAlert: noop as () => void,
  };
}
