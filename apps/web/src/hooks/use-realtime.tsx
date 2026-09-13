/**
 * BLASTI Realtime Hook — Client-side Socket.IO connection (v2)
 *
 * Provides managed Socket.IO connections with:
 * - Auto-connect / reconnect with exponential backoff
 * - Room management based on user role (agency, customer, admin, kiosk)
 * - Auto-rejoin rooms on reconnect
 * - Connection status tracking
 * - Toast notifications on disconnect/reconnect
 * - Cross-platform URL resolution (web via Caddy gateway, native via NEXT_PUBLIC_REALTIME_URL)
 * - Cleanup on unmount
 *
 * Three hook variants:
 * - useRealtime()         → low-level: full control over rooms & event subscriptions
 * - useAgencyRealtime()   → agency staff: auto-joins agency room, listens for queue/agency/staff events
 * - useCustomerRealtime() → customer: auto-joins customer room, listens for notification/reservation/queue events
 *
 * Usage:
 *   const { connected, on, off, emit, joinRoom, leaveRoom } = useRealtime()
 *   const { lastEvent, connected } = useAgencyRealtime(agencyId)
 *   const { lastEvent, connected } = useCustomerRealtime()
 */

'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import { useAppStore } from '@/store/use-app-store'
import { shouldShowAlert, enterSleepMode, clearSleep, subscribe as subscribeSleep, isReactivationDue, markReactivationShown, getSleepRecord, closeTurnNotifications } from '@/lib/turn-alert-sleep'

// ─── Types ─────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting'

export interface RealtimeEventData {
  type: string
  agencyId?: string
  userId?: string
  data: Record<string, unknown>
  timestamp: number
}

export type QueueEventData = RealtimeEventData
export type NotificationEventData = RealtimeEventData
export type KioskEventData = RealtimeEventData
export type ReservationEventData = RealtimeEventData
export type AgencyEventData = RealtimeEventData
export type StaffEventData = RealtimeEventData

type EventHandler<T = RealtimeEventData> = (event: T) => void
type SocketHandler = (...args: unknown[]) => void

// ─── URL Resolution ────────────────────────────────────────────────────────

const REALTIME_PORT = 3003

// Client-side token for Socket.IO handshake auth (matches REALTIME_SECRET on the server)
const REALTIME_TOKEN = process.env.NEXT_PUBLIC_REALTIME_TOKEN || ''

/**
 * Resolves the correct Socket.IO connection URL based on the runtime platform:
 *
 * - Electron/Capacitor (native): connect directly to cloud API / realtime server.
 *   The renderer is at a different origin than the API server, and the gateway
 *   cannot proxy WebSocket upgrades reliably. Use BLASTI_CLOUD_URL or localhost:3003.
 * - If NEXT_PUBLIC_REALTIME_URL is explicitly set, use it.
 * - Otherwise (web browser): use relative path "/" so the Caddy gateway proxies
 *   the connection, and pass XTransformPort=3003 as a query parameter.
 */
function resolveSocketUrl(): string {
  // Native platform: connect directly to cloud API (no gateway proxy)
  if (isNativePlatform()) {
    return (typeof process !== 'undefined' && (process as any).env?.BLASTI_CLOUD_URL)
      || `http://localhost:${REALTIME_PORT}`
  }
  // Explicit env override (e.g. for Capacitor builds with a specific URL)
  const nativeUrl = process.env.NEXT_PUBLIC_REALTIME_URL
  if (nativeUrl) {
    return nativeUrl
  }
  // Web: connect via the Caddy gateway using relative path
  return '/'
}

function resolveSocketOptions(): Parameters<typeof io>[1] {
  const isNative = isNativePlatform()
  const nativeUrl = process.env.NEXT_PUBLIC_REALTIME_URL

  const baseOptions: Parameters<typeof io>[1] = {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    // On native platforms, use fewer reconnection attempts to avoid
    // spamming "WebSocket connection failed" when cloud is down.
    // The LAN fallback (HTTP polling) handles offline events.
    reconnectionAttempts: isNative ? 5 : Infinity,
    reconnectionDelay: isNative ? 3000 : 1000,
    reconnectionDelayMax: 30000,
    timeout: 10000,
    auth: {
      token: process.env.NEXT_PUBLIC_REALTIME_TOKEN || useAppStore.getState().sessionToken || '',
    },
  }

  // Native or explicit URL: connecting directly, no gateway needed
  if (isNative || nativeUrl) {
    return baseOptions
  }

  // Web: route through Caddy gateway via XTransformPort
  return {
    ...baseOptions,
    query: {
      XTransformPort: String(REALTIME_PORT),
    },
  }
}

// ─── Singleton Socket Management ───────────────────────────────────────────
// We use a singleton pattern so multiple hook instances share the same socket.
// The socket is created lazily and destroyed when the last consumer unmounts.

let globalSocket: Socket | null = null
let connectionCount = 0

// LAN Socket.IO fallback (connects to desktop's local server when cloud is unreachable)
let lanSocket: Socket | null = null
let lanSocketConnected = false

function isNativePlatform(): boolean {
  return !!(window as any).electronAPI || !!(window as any).Capacitor
}

function getSocket(): Socket {
  if (!globalSocket) {
    globalSocket = io(resolveSocketUrl(), resolveSocketOptions())
  }
  return globalSocket
}

function releaseSocket(): void {
  connectionCount--
  if (connectionCount <= 0) {
    if (globalSocket) {
      globalSocket.disconnect()
      // M35: Never destroy the socket singleton — just disconnect.
      // This prevents premature destruction when one consumer unmounts
      // while another is about to mount (e.g., during hot reload).
      // globalSocket stays allocated; getSocket() will reconnect it.
    }
    connectionCount = 0
  }
}

// ─── Core Hook: useRealtime ────────────────────────────────────────────────

interface UseRealtimeOptions {
  /** Auto-connect on mount (default: true) */
  autoConnect?: boolean
  /** Rooms to join on connect */
  rooms?: string[]
}

// ── LAN Socket Connection ──────────────────────────────────────────────────

async function connectLanSocket() {
  try {
    const { getGlobalLanServer } = await import('@/hooks/use-lan-mode')
    const server = getGlobalLanServer()
    if (!server) return

    // Skip LAN socket connection — the local API (port 3080) serves HTTP only,
    // it does not run a Socket.IO server. Attempting to connect would spam
    // WebSocket connection refused errors in the console. The cloud Socket.IO
    // connection handles all realtime events; LAN failover is HTTP-only.
    return
    const lanUrl = `http://${server.ip}:${server.port}`
    lanSocket = io(lanUrl, {
      transports: ['websocket', 'polling'],
      timeout: 5000,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    })

    const queueEvents = [
      'queue:called', 'queue:joined', 'queue:completed', 'queue:cancelled',
      'queue:paused', 'queue:resumed', 'queue:walk-in', 'queue:postponed',
      'notification:new', 'notification:read',
      'agency:update', 'staff:update',
    ]

    lanSocket.on('connect', () => {
      lanSocketConnected = true
      console.log('[Realtime] LAN socket connected to', lanUrl)
      // Update connection status to connected
      setConnectionStatus('connected')
    })

    lanSocket.on('disconnect', () => {
      lanSocketConnected = false
      console.log('[Realtime] LAN socket disconnected')
      if (!globalSocket?.connected) {
        setConnectionStatus('disconnected')
      }
    })

    lanSocket.on('error', () => {
      lanSocketConnected = false
    })
  } catch (err) {
    console.warn('[Realtime] LAN fallback failed:', err)
  }
}

export function useRealtime(options?: UseRealtimeOptions) {
  const { autoConnect = true, rooms: initialRooms = [] } = options ?? {}
  const sessionToken = useAppStore(s => s.sessionToken)
  const socketRef = useRef<Socket | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const joinedRoomsRef = useRef<Set<string>>(new Set(initialRooms))
  const listenersRef = useRef<Map<string, Set<SocketHandler>>>(new Map())

  // ─── Connection Lifecycle ─────────────────────────────────────────────

  useEffect(() => {
    if (!autoConnect) return

    const socket = getSocket()
    socketRef.current = socket
    connectionCount++

    const onConnect = () => {
      setConnectionStatus('connected')
      // Re-join all rooms that were previously joined
      for (const room of joinedRoomsRef.current) {
        socket.emit('join:room', room)
      }
      // Disconnect LAN socket — cloud is back
      if (lanSocket) {
        lanSocket.disconnect()
        lanSocket = null
        lanSocketConnected = false
      }
    }

    const onDisconnect = (reason: string) => {
      setConnectionStatus('disconnected')

      // On native platforms, try connecting to LAN server after 5s delay
      if (isNativePlatform() && !lanSocket) {
        setTimeout(() => {
          if (globalSocket?.connected) return // cloud reconnected
          connectLanSocket()
        }, 5000)
      }
    }

    const onConnecting = () => {
      setConnectionStatus('connecting')
    }

    // When all reconnection attempts are exhausted (native: 5 attempts),
    // stop trying and accept offline mode. The HTTP LAN fallback handles data.
    const onReconnectFailed = () => {
      setConnectionStatus('disconnected')
      console.log('[Realtime] Cloud reconnection failed — staying in offline mode')
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('reconnect_attempt', onConnecting)
    socket.on('connect_error', onConnecting)
    socket.on('reconnect_failed', onReconnectFailed)

    if (!socket.connected) {
      socket.connect()
      setConnectionStatus('connecting')
    } else {
      setConnectionStatus('connected')
    }

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('reconnect_attempt', onConnecting)
      socket.off('connect_error', onConnecting)
      socket.off('reconnect_failed', onReconnectFailed)

      releaseSocket()
      socketRef.current = null
    }
  }, [autoConnect])

  // C3: Send auth with session token when it changes
  useEffect(() => {
    const authToken = sessionToken || REALTIME_TOKEN
    if (socketRef.current?.connected) {
      socketRef.current.emit('auth', { token: authToken })
    }
  }, [sessionToken])

  // ─── Room Management ─────────────────────────────────────────────────

  const joinRoom = useCallback((room: string) => {
    joinedRoomsRef.current.add(room)
    socketRef.current?.emit('join:room', room)
  }, [])

  const leaveRoom = useCallback((room: string) => {
    joinedRoomsRef.current.delete(room)
    socketRef.current?.emit('leave:room', room)
  }, [])

  // Convenience methods that map to the server's room protocol
  const joinAgency = useCallback((agencyId: string) => {
    joinedRoomsRef.current.add(`agency:${agencyId}`)
    socketRef.current?.emit('join:agency', agencyId)
  }, [])

  const leaveAgency = useCallback((agencyId: string) => {
    joinedRoomsRef.current.delete(`agency:${agencyId}`)
    socketRef.current?.emit('leave:agency', agencyId)
  }, [])

  const joinCustomer = useCallback((userId: string) => {
    joinedRoomsRef.current.add(`customer:${userId}`)
    socketRef.current?.emit('join:customer', userId)
  }, [])

  const leaveCustomer = useCallback((userId: string) => {
    joinedRoomsRef.current.delete(`customer:${userId}`)
    socketRef.current?.emit('leave:customer', userId)
  }, [])

  const joinKiosk = useCallback((agencyId: string) => {
    joinedRoomsRef.current.add(`kiosk:${agencyId}`)
    socketRef.current?.emit('join:kiosk', agencyId)
  }, [])

  const leaveKiosk = useCallback((agencyId: string) => {
    joinedRoomsRef.current.delete(`kiosk:${agencyId}`)
    socketRef.current?.emit('leave:kiosk', agencyId)
  }, [])

  const joinAdmin = useCallback(() => {
    joinedRoomsRef.current.add('admin:global')
    socketRef.current?.emit('join:admin')
  }, [])

  const leaveAdmin = useCallback(() => {
    joinedRoomsRef.current.delete('admin:global')
    socketRef.current?.emit('leave:admin')
  }, [])

  // ─── Generic Event Subscription ──────────────────────────────────────

  const on = useCallback((event: string, handler: SocketHandler) => {
    if (!listenersRef.current.has(event)) {
      listenersRef.current.set(event, new Set())
    }
    listenersRef.current.get(event)!.add(handler)
    socketRef.current?.on(event, handler)
    return () => {
      listenersRef.current.get(event)?.delete(handler)
      socketRef.current?.off(event, handler)
    }
  }, [])

  const off = useCallback((event: string, handler: SocketHandler) => {
    listenersRef.current.get(event)?.delete(handler)
    socketRef.current?.off(event, handler)
  }, [])

  const emit = useCallback((event: string, ...args: unknown[]) => {
    socketRef.current?.emit(event, ...args)
  }, [])

  // ─── Typed Event Subscriptions (Queue) ──────────────────────────────

  const onQueueCreated = useCallback((handler: EventHandler) => on('queue:created', handler as SocketHandler), [on])
  const onQueueUpdated = useCallback((handler: EventHandler) => on('queue:updated', handler as SocketHandler), [on])
  const onQueueCalled = useCallback((handler: EventHandler) => on('queue:called', handler as SocketHandler), [on])
  const onQueueCompleted = useCallback((handler: EventHandler) => on('queue:completed', handler as SocketHandler), [on])
  const onQueueNoShow = useCallback((handler: EventHandler) => on('queue:no-show', handler as SocketHandler), [on])
  const onQueueCancelled = useCallback((handler: EventHandler) => on('queue:cancelled', handler as SocketHandler), [on])
  const onQueueJoined = useCallback((handler: EventHandler) => on('queue:joined', handler as SocketHandler), [on])
  const onQueueWalkIn = useCallback((handler: EventHandler) => on('queue:walk-in', handler as SocketHandler), [on])
  const onQueuePaused = useCallback((handler: EventHandler) => on('queue:paused', handler as SocketHandler), [on])
  const onQueueResumed = useCallback((handler: EventHandler) => on('queue:resumed', handler as SocketHandler), [on])
  const onQueuePositionChanged = useCallback((handler: EventHandler) => on('queue:position-changed', handler as SocketHandler), [on])
  const onQueueSettingsUpdated = useCallback((handler: EventHandler) => on('queue:settings-updated', handler as SocketHandler), [on])

  // ─── Typed Event Subscriptions (Reservation) ────────────────────────

  const onReservationCreated = useCallback((handler: EventHandler) => on('reservation:created', handler as SocketHandler), [on])
  const onReservationUpdated = useCallback((handler: EventHandler) => on('reservation:updated', handler as SocketHandler), [on])
  const onReservationCancelled = useCallback((handler: EventHandler) => on('reservation:cancelled', handler as SocketHandler), [on])

  // ─── Typed Event Subscriptions (Notification) ────────────────────────

  const onNotification = useCallback((handler: EventHandler) => on('notification:new', handler as SocketHandler), [on])
  const onTurnApproaching = useCallback((handler: EventHandler) => on('notification:turn-approaching', handler as SocketHandler), [on])
  const onYourTurn = useCallback((handler: EventHandler) => on('notification:your-turn', handler as SocketHandler), [on])

  // ─── Typed Event Subscriptions (Kiosk) ──────────────────────────────

  const onKioskUpdate = useCallback((handler: EventHandler) => on('kiosk:update', handler as SocketHandler), [on])

  // ─── Typed Event Subscriptions (Agency) ─────────────────────────────

  const onAgencyUpdated = useCallback((handler: EventHandler) => on('agency:updated', handler as SocketHandler), [on])

  // ─── Typed Event Subscriptions (Staff) ──────────────────────────────

  const onStaffUpdated = useCallback((handler: EventHandler) => on('staff:updated', handler as SocketHandler), [on])

  // ─── Any Event (debug/logging) ──────────────────────────────────────

  const onAnyEvent = useCallback((handler: (...args: unknown[]) => void) => {
    socketRef.current?.onAny(handler)
    return () => {
      socketRef.current?.offAny(handler)
    }
  }, [])

  // ─── Backward-compatible subscribe/unsubscribe ──────────────────────

  const subscribe = useCallback((event: string, handler: SocketHandler) => {
    return on(event, handler)
  }, [on])

  const unsubscribe = useCallback((event: string, handler: SocketHandler) => {
    off(event, handler)
  }, [off])

  return {
    // Connection state
    isConnected: connectionStatus === 'connected',
    connectionStatus,
    connected: connectionStatus === 'connected',

    // Low-level
    on,
    off,
    emit,

    // Room management (generic)
    joinRoom,
    leaveRoom,

    // Room management (typed)
    joinAgency,
    leaveAgency,
    joinCustomer,
    leaveCustomer,
    joinKiosk,
    leaveKiosk,
    joinAdmin,
    leaveAdmin,

    // Queue event subscriptions
    onQueueCreated,
    onQueueUpdated,
    onQueueCalled,
    onQueueCompleted,
    onQueueNoShow,
    onQueueCancelled,
    onQueueJoined,
    onQueueWalkIn,
    onQueuePaused,
    onQueueResumed,
    onQueuePositionChanged,
    onQueueSettingsUpdated,

    // Reservation event subscriptions
    onReservationCreated,
    onReservationUpdated,
    onReservationCancelled,

    // Notification event subscriptions
    onNotification,
    onTurnApproaching,
    onYourTurn,

    // Kiosk event subscriptions
    onKioskUpdate,

    // Agency event subscriptions
    onAgencyUpdated,

    // Staff event subscriptions
    onStaffUpdated,

    // Generic (backward compat)
    subscribe,
    unsubscribe,
    onAnyEvent,
  }
}

// ─── Role-Specific Hook: useAgencyRealtime ────────────────────────────────

/**
 * Hook specifically for agency staff to listen for queue events.
 * Automatically joins the agency room on connect and re-joins on reconnect.
 *
 * @param agencyId - The agency ID to join. If null, no room is joined.
 * @returns lastEvent and connected status
 */
export function useAgencyRealtime(agencyId: string | null) {
  const userId = useAppStore((s) => s.user?.id)
  const userRole = useAppStore((s) => s.user?.role)
  const isAuthenticated = useAppStore((s) => s.isAuthenticated)
  const [lastEvent, setLastEvent] = useState<RealtimeEventData | null>(null)
  const [connected, setConnected] = useState(false)
  const prevAgencyIdRef = useRef<string | null>(null)

  const socketRef = useRef<Socket | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const joinedRoomsRef = useRef<Set<string>>(new Set())
  const userRoleRef = useRef(userRole)
  useEffect(() => { userRoleRef.current = userRole }, [userRole])

  useEffect(() => {
    if (!isAuthenticated || !userId) return
    if (userRoleRef.current !== 'AGENCY_OWNER' && userRoleRef.current !== 'AGENCY_STAFF' && userRoleRef.current !== 'SUPER_ADMIN') return

    const socket = getSocket()
    socketRef.current = socket
    connectionCount++

    // Auto-join rooms
    const roomsToJoin = new Set<string>()
    if (agencyId) {
      roomsToJoin.add(`agency:${agencyId}`)
    }
    if (userRoleRef.current === 'SUPER_ADMIN') {
      roomsToJoin.add('admin:global')
    }
    joinedRoomsRef.current = roomsToJoin

    const onConnect = () => {
      setConnectionStatus('connected')
      setConnected(true)
      // Re-join all tracked rooms
      for (const room of joinedRoomsRef.current) {
        if (room.startsWith('agency:')) {
          socket.emit('join:agency', room.replace('agency:', ''))
        } else if (room === 'admin:global') {
          socket.emit('join:admin')
        } else {
          socket.emit('join:room', room)
        }
      }
    }

    const onDisconnect = () => {
      setConnectionStatus('disconnected')
      setConnected(false)
    }

    const onConnecting = () => {
      setConnectionStatus('connecting')
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('reconnect_attempt', onConnecting)
    socket.on('connect_error', onConnecting)

    // Event listeners for agency-relevant events
    const agencyEvents = [
      'queue:created', 'queue:updated', 'queue:called', 'queue:completed',
      'queue:no-show', 'queue:cancelled', 'queue:joined', 'queue:walk-in',
      'queue:paused', 'queue:resumed', 'queue:position-changed', 'queue:settings-updated',
      'agency:updated', 'staff:updated',
    ]

    const handleEvent = (data: RealtimeEventData) => {
      setLastEvent(data)
    }

    for (const evt of agencyEvents) {
      socket.on(evt, handleEvent as SocketHandler)
    }

    if (!socket.connected) {
      socket.connect()
      setConnectionStatus('connecting')
    } else {
      onConnect() // Already connected, trigger join
    }

    // Track agencyId changes for room updates
    prevAgencyIdRef.current = agencyId

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('reconnect_attempt', onConnecting)
      socket.off('connect_error', onConnecting)

      for (const evt of agencyEvents) {
        socket.off(evt, handleEvent as SocketHandler)
      }

      // M32: Leave agency room on unmount
      if (prevAgencyIdRef.current) {
        socket.emit('leave:agency', prevAgencyIdRef.current)
      }

      releaseSocket()
      socketRef.current = null
    }
  }, [isAuthenticated, userId, agencyId])

  return {
    lastEvent,
    connected,
    connectionStatus,
    isConnected: connectionStatus === 'connected',
  }
}

// ─── Role-Specific Hook: useCustomerRealtime ──────────────────────────────

/**
 * Hook specifically for customers to listen for their personal events.
 * Automatically joins the customer room on connect and re-joins on reconnect.
 *
 * @returns lastEvent and connected status
 */
export function useCustomerRealtime() {
  const userId = useAppStore((s) => s.user?.id)
  const userRole = useAppStore((s) => s.user?.role)
  const isAuthenticated = useAppStore((s) => s.isAuthenticated)
  const [lastEvent, setLastEvent] = useState<RealtimeEventData | null>(null)
  const [connected, setConnected] = useState(false)

  const socketRef = useRef<Socket | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const joinedRoomsRef = useRef<Set<string>>(new Set())
  const userIdRef = useRef(userId)
  useEffect(() => { userIdRef.current = userId }, [userId])

  useEffect(() => {
    if (!isAuthenticated || !userIdRef.current) return
    if (userRole !== 'CUSTOMER') return

    const socket = getSocket()
    socketRef.current = socket
    connectionCount++

    // Auto-join customer room
    const roomsToJoin = new Set<string>()
    roomsToJoin.add(`customer:${userIdRef.current}`)
    joinedRoomsRef.current = roomsToJoin

    const onConnect = () => {
      setConnectionStatus('connected')
      setConnected(true)
      // Re-join customer room
      socket.emit('join:customer', userIdRef.current)
    }

    const onDisconnect = () => {
      setConnectionStatus('disconnected')
      setConnected(false)
    }

    const onConnecting = () => {
      setConnectionStatus('connecting')
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('reconnect_attempt', onConnecting)
    socket.on('connect_error', onConnecting)

    // Event listeners for customer-relevant events
    const customerEvents = [
      'notification:new', 'notification:turn-approaching', 'notification:your-turn',
      'reservation:created', 'reservation:updated', 'reservation:cancelled',
      'queue:position-changed', 'queue:called', 'queue:completed',
      'queue:no-show', 'queue:cancelled',
    ]

    const handleEvent = (data: RealtimeEventData) => {
      setLastEvent(data)
    }

    for (const evt of customerEvents) {
      socket.on(evt, handleEvent as SocketHandler)
    }

    if (!socket.connected) {
      socket.connect()
      setConnectionStatus('connecting')
    } else {
      onConnect() // Already connected, trigger join
    }

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('reconnect_attempt', onConnecting)
      socket.off('connect_error', onConnecting)

      for (const evt of customerEvents) {
        socket.off(evt, handleEvent as SocketHandler)
      }

      // M33: Leave customer room on unmount
      if (userIdRef.current) {
        socket.emit('leave:customer', userIdRef.current)
      }

      releaseSocket()
      socketRef.current = null
    }
  }, [isAuthenticated, userId])

  return {
    lastEvent,
    connected,
    connectionStatus,
    isConnected: connectionStatus === 'connected',
  }
}

// ─── Aggressive Turn Alert Hook ─────────────────────────────────────────────

/**
 * useTurnAlert — Hook for the aggressive turn alert system.
 * 
 * Listens for TURN_CALLED events via Socket.IO and manages the full-screen
 * alert state. Also fires local notifications via the notification channel.
 */
export function useTurnAlert(userId: string | undefined) {
  const [showTurnAlert, setShowTurnAlert] = useState(false)
  const [turnAlertData, setTurnAlertData] = useState<{
    reservationId?: string;
    ticketNumber: string;
    agencyName: string;
  } | null>(null)
  const { subscribe, joinRoom, leaveRoom } = useRealtime()

  // H17: Join customer room for turn alerts
  const userIdRef = useRef(userId)
  useEffect(() => { userIdRef.current = userId }, [userId])

  useEffect(() => {
    if (!userId) return
    joinRoom(`customer:${userId}`)
    return () => { leaveRoom(`customer:${userId}`) }
  }, [userId, joinRoom, leaveRoom])

  useEffect(() => {
    if (!userId) return

    // Listen for notification:your-turn events
    const unsubYourTurn = subscribe('notification:your-turn', (event: any) => {
      const data = event?.data || event
      if (data?.userId === userId) {
        const reservationId = data?.reservationId || data?.id
        // Sleep-state check: if the alert is suppressed (sleep mode), do not show
        if (reservationId && !shouldShowAlert(reservationId)) return
        const ticketNumber = data?.ticketNumber || data?.displayNumber || '---'
        const agencyName = data?.agencyName || ''

        setTurnAlertData({ reservationId, ticketNumber, agencyName })
        setShowTurnAlert(true)

        // Also fire a local notification (wakes phone, drops banner)
        import('@/lib/notification-channel').then(({ scheduleTurnNotification }) => {
          scheduleTurnNotification(
            'إنه دورك! / It\'s Your Turn!',
            `Ticket ${ticketNumber} at ${agencyName}`,
            ticketNumber
          )
        }).catch(() => {})
      }
    })

    // Also listen for queue:called events as backup
    const unsubQueueCalled = subscribe('queue:called', (event: any) => {
      const data = event?.data || event
      if (data?.userId === userId) {
        const reservationId = data?.reservationId || data?.id
        // Sleep-state check: if the alert is suppressed (sleep mode), do not show
        if (reservationId && !shouldShowAlert(reservationId)) return
        const ticketNumber = data?.displayNumber || data?.ticketNumber || '---'
        const agencyName = data?.agencyName || ''

        setTurnAlertData({ reservationId, ticketNumber, agencyName })
        setShowTurnAlert(true)

        import('@/lib/notification-channel').then(({ scheduleTurnNotification }) => {
          scheduleTurnNotification(
            'إنه دورك! / It\'s Your Turn!',
            `Ticket ${ticketNumber} at ${agencyName}`,
            ticketNumber
          )
        }).catch(() => {})
      }
    })

    return () => {
      unsubYourTurn()
      unsubQueueCalled()
    }
  }, [userId, subscribe])

  // Sync with sleep-state module: re-show alert ONCE when 10-min sleep expires,
  // and hide while sleeping.
  useEffect(() => {
    const unsub = subscribeSleep(() => {
      const rec = getSleepRecord()
      if (!rec) return
      if (isReactivationDue(rec.reservationId)) {
        markReactivationShown(rec.reservationId)
        setShowTurnAlert(true)
        // Fire local notification for reactivation
        if (turnAlertData) {
          import('@/lib/notification-channel').then(({ scheduleTurnNotification }) => {
            scheduleTurnNotification(
              'إنه دورك! / It\'s Your Turn!',
              `Ticket ${turnAlertData.ticketNumber} at ${turnAlertData.agencyName}`,
              turnAlertData.ticketNumber
            )
          }).catch(() => {})
        }
      } else if (shouldShowAlert(rec.reservationId)) {
        // Sleeping or done — keep hidden
        setShowTurnAlert(false)
      }
    })
    return unsub
  }, [turnAlertData])

  const dismissTurnAlert = useCallback(() => {
    if (turnAlertData?.reservationId) {
      enterSleepMode(turnAlertData.reservationId)
    }
    closeTurnNotifications()
    setShowTurnAlert(false)
  }, [turnAlertData])

  return { showTurnAlert, turnAlertData, dismissTurnAlert }
}
