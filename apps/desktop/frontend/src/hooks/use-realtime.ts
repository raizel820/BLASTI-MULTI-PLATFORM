/**
 * useRealtime — Desktop realtime hook (SINGLE SOURCE OF TRUTH)
 *
 * IMPORTANT: this file replaces the former use-realtime.ts / use-realtime.tsx
 * shadow-file pair. Vite resolves `.ts` before `.tsx`, so this `.ts` file was
 * the live implementation; the `.tsx` stub was dead code. The two have been
 * MERGED here (the richer `.ts` handler surface + the `.tsx`-only exports:
 * `connected`, `joinRoom`/`leaveRoom`, `on`/`off`/`emit`, `useAgencyRealtime`,
 * `useCustomerRealtime`) so that every consumer import
 * (`@/hooks/use-realtime` in agency-dashboard.tsx, agency-fullscreen.tsx,
 * dashboard/SimpleMobileDashboard.tsx, shared/connection-status.tsx) resolves
 * to exactly one module with the complete API surface.
 *
 * Desktop transport reality: the desktop frontend talks to the LOCAL API at
 * 127.0.0.1:3080 over HTTP polling (use-api/use-notifications). There is no
 * Socket.IO connection on desktop, so all room management and event
 * subscriptions are no-ops that return safe unsubscribe functions. Data
 * freshness is provided by the polling layers — this hook exists so shared
 * agency components compile and run unchanged.
 *
 * Every subscription method is a guarded no-op: calling it never throws and
 * always returns a callable cleanup function.
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
    // Connection state — always "disconnected" (polling mode)
    connected: false as const, // alias kept for .tsx-stub consumers
    isConnected: false as const,
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

    // Low-level event methods — no-ops (from the merged .tsx stub)
    on: noopSub as (event: string, handler: (...args: unknown[]) => void) => () => void,
    off: noop as (event: string, handler: (...args: unknown[]) => void) => void,
    emit: noop as (event: string, ...args: unknown[]) => void,

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

// ─── Agency realtime hook (merged from .tsx stub) ───────────────────────────

/**
 * useAgencyRealtime — Desktop polling-only no-op.
 *
 * On Desktop, agency staff receive updates via polling (useNotifications,
 * use-api with usePolling). Provided so shared/web-derived components that
 * call this hook compile and run unchanged.
 */
export function useAgencyRealtime(_agencyId?: string) {
  return {
    lastEvent: null as RealtimeEventData | null,
    connected: false as const,
    connectionStatus: 'disconnected' as ConnectionStatus,

    // Convenience event subscriptions — no-ops
    onQueueCreated: noopSub as (handler: EventHandler) => () => void,
    onQueueCalled: noopSub as (handler: EventHandler) => () => void,
    onQueueUpdated: noopSub as (handler: EventHandler) => () => void,
    onQueueCompleted: noopSub as (handler: EventHandler) => () => void,
    onAgencyUpdated: noopSub as (handler: EventHandler) => () => void,
    onStaffUpdated: noopSub as (handler: EventHandler) => () => void,
  };
}

// ─── Customer realtime hook (merged from .tsx stub) ─────────────────────────

/**
 * useCustomerRealtime — Desktop polling-only no-op.
 *
 * On Desktop, customers receive updates via polling (useNotifications,
 * use-api with usePolling). Provided so shared/web-derived components that
 * call this hook compile and run unchanged.
 */
export function useCustomerRealtime(_userId?: string) {
  return {
    lastEvent: null as RealtimeEventData | null,
    connected: false as const,
    connectionStatus: 'disconnected' as ConnectionStatus,

    // Convenience event subscriptions — no-ops
    onNotification: noopSub as (handler: EventHandler) => () => void,
    onYourTurn: noopSub as (handler: EventHandler) => () => void,
    onTurnApproaching: noopSub as (handler: EventHandler) => () => void,
    onReservationCreated: noopSub as (handler: EventHandler) => () => void,
    onReservationUpdated: noopSub as (handler: EventHandler) => () => void,
    onQueueJoined: noopSub as (handler: EventHandler) => () => void,
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
