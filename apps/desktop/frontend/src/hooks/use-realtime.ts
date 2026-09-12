/**
 * useRealtime — Desktop polling-only stub
 *
 * On Desktop, real-time updates are handled via HTTP polling against the local API.
 * Socket.IO integration will come in a later iteration.
 *
 * All methods are no-ops that return no-op cleanup functions.
 */

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting';

export interface RealtimeEventData {
  type: string;
  agencyId?: string;
  userId?: string;
  data: Record<string, unknown>;
  timestamp: number;
}

type EventHandler = (event: RealtimeEventData) => void;

const noop = () => {};
// A no-op subscriber: takes a handler argument, returns a no-op cleanup function
const noopSub = (_handler?: unknown) => noop;

export function useRealtime() {
  return {
    // Connection state — always disconnected (polling mode)
    isConnected: false as const,
    connectionStatus: 'disconnected' as ConnectionStatus,

    // Room management — no-ops
    joinAgency: noop as (agencyId: string) => void,
    leaveAgency: noop as (agencyId: string) => void,
    joinCustomer: noop as (userId: string) => void,
    leaveCustomer: noop as (userId: string) => void,
    joinKiosk: noop as (agencyId: string) => void,
    leaveKiosk: noop as (agencyId: string) => void,
    joinAdmin: noop as () => void,
    leaveAdmin: noop as () => void,

    // Queue event subscriptions — no-ops
    onQueueCreated: noopSub as (handler: EventHandler) => () => void,
    onQueueUpdated: noopSub as (handler: EventHandler) => () => void,
    onQueueCalled: noopSub as (handler: EventHandler) => () => void,
    onQueueCompleted: noopSub as (handler: EventHandler) => () => void,
    onQueueNoShow: noopSub as (handler: EventHandler) => () => void,
    onQueueCancelled: noopSub as (handler: EventHandler) => () => void,
    onQueueJoined: noopSub as (handler: EventHandler) => () => void,
    onQueueWalkIn: noopSub as (handler: EventHandler) => () => void,
    onQueuePaused: noopSub as (handler: EventHandler) => () => void,
    onQueueResumed: noopSub as (handler: EventHandler) => () => void,
    onQueuePositionChanged: noopSub as (handler: EventHandler) => () => void,
    onQueueSettingsUpdated: noopSub as (handler: EventHandler) => () => void,

    // Reservation event subscriptions — no-ops
    onReservationCreated: noopSub as (handler: EventHandler) => () => void,
    onReservationUpdated: noopSub as (handler: EventHandler) => () => void,
    onReservationCancelled: noopSub as (handler: EventHandler) => () => void,

    // Notification event subscriptions — no-ops
    onNotification: noopSub as (handler: EventHandler) => () => void,
    onTurnApproaching: noopSub as (handler: EventHandler) => () => void,
    onYourTurn: noopSub as (handler: EventHandler) => () => void,

    // Kiosk event subscriptions — no-ops
    onKioskUpdate: noopSub as (handler: EventHandler) => () => void,

    // Agency event subscriptions — no-ops
    onAgencyUpdated: noopSub as (handler: EventHandler) => () => void,

    // Staff event subscriptions — no-ops
    onStaffUpdated: noopSub as (handler: EventHandler) => () => void,

    // Generic — no-ops
    subscribe: noopSub as (event: string, handler: (...args: unknown[]) => void) => () => void,
    unsubscribe: noop as (event: string, handler: (...args: unknown[]) => void) => void,
    onAnyEvent: noopSub as (handler: (...args: unknown[]) => void) => () => void,
  };
}

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
