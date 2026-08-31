/**
 * BLASTI Realtime Hook — Client-side Socket.IO connection
 *
 * Connects to the BLASTI realtime service (Socket.IO on port 3003 via Caddy gateway)
 * and provides real-time event subscriptions for queue updates, notifications, etc.
 *
 * Features:
 * - Auto-reconnect with exponential backoff
 * - Room management (join/leave agency, customer, kiosk, admin rooms)
 * - Event subscriptions with cleanup
 * - Graceful fallback to polling when disconnected
 * - Connection status tracking
 *
 * Usage:
 *   const { isConnected, joinAgency, onQueueCalled } = useRealtime()
 *
 *   // Join an agency room to receive its updates
 *   joinAgency(agencyId)
 *
 *   // Subscribe to specific events
 *   onQueueCalled((data) => { ... })
 */

'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { io, Socket } from 'socket.io-client'
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

type EventHandler = (event: RealtimeEventData) => void
type SocketHandler = (...args: unknown[]) => void

// ─── Socket.IO Connection ─────────────────────────────────────────────────

const SOCKET_URL = '/'
const REALTIME_PORT = 3003

// Client-side token for Socket.IO handshake auth (matches REALTIME_SECRET on the server)
const REALTIME_TOKEN = process.env.NEXT_PUBLIC_REALTIME_TOKEN || ''

let globalSocket: Socket | null = null
let connectionCount = 0

function isElectronOrNative(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as any).electronAPI || navigator.userAgent.includes('Electron') || !!(window as any).Capacitor
}

function getSocket(): Socket {
  if (!globalSocket) {
    // In Electron/Capacitor: connect directly to cloud API (no gateway proxy).
    // The renderer is at a different origin than the API server, so using the
    // gateway's XTransformPort doesn't work for WebSocket upgrades.
    // In web browser: use relative URL with XTransformPort for gateway routing.
    const isNative = isElectronOrNative()
    const socketUrl = isNative
      ? (process.env.BLASTI_CLOUD_URL || `http://localhost:${REALTIME_PORT}`)
      : SOCKET_URL

    globalSocket = io(socketUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      timeout: 10000,
      // Only add XTransformPort for web browser (not native)
      ...(isNative ? {} : { query: { XTransformPort: String(REALTIME_PORT) } }),
      auth: {
        token: REALTIME_TOKEN,
      },
    })
  }
  return globalSocket
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useRealtime() {
  const socketRef = useRef<Socket | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const listenersRef = useRef<Map<string, Set<(...args: unknown[]) => void>>>(new Map())

  // Initialize socket connection
  useEffect(() => {
    const socket = getSocket()
    socketRef.current = socket
    connectionCount++

    const onConnect = () => {
      setConnectionStatus('connected')
    }

    const onDisconnect = () => {
      setConnectionStatus('disconnected')
    }

    const onConnecting = () => {
      setConnectionStatus('connecting')
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('reconnect_attempt', onConnecting)
    socket.on('connect_error', onConnecting)

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

      connectionCount--
      if (connectionCount <= 0) {
        socket.disconnect()
        globalSocket = null
        connectionCount = 0
      }
    }
  }, [])

  // ─── Room Management ───────────────────────────────────────────────────

  const joinAgency = useCallback((agencyId: string) => {
    socketRef.current?.emit('join:agency', agencyId)
  }, [])

  const leaveAgency = useCallback((agencyId: string) => {
    socketRef.current?.emit('leave:agency', agencyId)
  }, [])

  const joinCustomer = useCallback((userId: string) => {
    socketRef.current?.emit('join:customer', userId)
  }, [])

  const leaveCustomer = useCallback((userId: string) => {
    socketRef.current?.emit('leave:customer', userId)
  }, [])

  const joinKiosk = useCallback((agencyId: string) => {
    socketRef.current?.emit('join:kiosk', agencyId)
  }, [])

  const leaveKiosk = useCallback((agencyId: string) => {
    socketRef.current?.emit('leave:kiosk', agencyId)
  }, [])

  const joinAdmin = useCallback(() => {
    socketRef.current?.emit('join:admin')
  }, [])

  const leaveAdmin = useCallback(() => {
    socketRef.current?.emit('leave:admin')
  }, [])

  // ─── Generic Event Subscription ────────────────────────────────────────

  const subscribe = useCallback((event: string, handler: (...args: unknown[]) => void) => {
    if (!listenersRef.current.has(event)) {
      listenersRef.current.set(event, new Set())
    }
    listenersRef.current.get(event)!.add(handler)

    socketRef.current?.on(event, handler as (...args: unknown[]) => void)

    return () => {
      listenersRef.current.get(event)?.delete(handler)
      socketRef.current?.off(event, handler as (...args: unknown[]) => void)
    }
  }, [])

  const unsubscribe = useCallback((event: string, handler: (...args: unknown[]) => void) => {
    listenersRef.current.get(event)?.delete(handler)
    socketRef.current?.off(event, handler as (...args: unknown[]) => void)
  }, [])

  // ─── Queue Event Subscriptions ────────────────────────────────────────

  const onQueueCreated = useCallback((handler: EventHandler) => {
    return subscribe('queue:created', handler as SocketHandler)
  }, [subscribe])

  const onQueueUpdated = useCallback((handler: EventHandler) => {
    return subscribe('queue:updated', handler as SocketHandler)
  }, [subscribe])

  const onQueueCalled = useCallback((handler: EventHandler) => {
    return subscribe('queue:called', handler as SocketHandler)
  }, [subscribe])

  const onQueueCompleted = useCallback((handler: EventHandler) => {
    return subscribe('queue:completed', handler as SocketHandler)
  }, [subscribe])

  const onQueueNoShow = useCallback((handler: EventHandler) => {
    return subscribe('queue:no-show', handler as SocketHandler)
  }, [subscribe])

  const onQueueCancelled = useCallback((handler: EventHandler) => {
    return subscribe('queue:cancelled', handler as SocketHandler)
  }, [subscribe])

  const onQueueJoined = useCallback((handler: EventHandler) => {
    return subscribe('queue:joined', handler as SocketHandler)
  }, [subscribe])

  const onQueueWalkIn = useCallback((handler: EventHandler) => {
    return subscribe('queue:walk-in', handler as SocketHandler)
  }, [subscribe])

  const onQueuePaused = useCallback((handler: EventHandler) => {
    return subscribe('queue:paused', handler as SocketHandler)
  }, [subscribe])

  const onQueueResumed = useCallback((handler: EventHandler) => {
    return subscribe('queue:resumed', handler as SocketHandler)
  }, [subscribe])

  const onQueuePositionChanged = useCallback((handler: EventHandler) => {
    return subscribe('queue:position-changed', handler as SocketHandler)
  }, [subscribe])

  const onQueueSettingsUpdated = useCallback((handler: EventHandler) => {
    return subscribe('queue:settings-updated', handler as SocketHandler)
  }, [subscribe])

  // ─── Reservation Event Subscriptions ─────────────────────────────────

  const onReservationCreated = useCallback((handler: EventHandler) => {
    return subscribe('reservation:created', handler as SocketHandler)
  }, [subscribe])

  const onReservationUpdated = useCallback((handler: EventHandler) => {
    return subscribe('reservation:updated', handler as SocketHandler)
  }, [subscribe])

  const onReservationCancelled = useCallback((handler: EventHandler) => {
    return subscribe('reservation:cancelled', handler as SocketHandler)
  }, [subscribe])

  // ─── Notification Event Subscriptions ──────────────────────────────────

  const onNotification = useCallback((handler: EventHandler) => {
    return subscribe('notification:new', handler as SocketHandler)
  }, [subscribe])

  const onTurnApproaching = useCallback((handler: EventHandler) => {
    return subscribe('notification:turn-approaching', handler as SocketHandler)
  }, [subscribe])

  const onYourTurn = useCallback((handler: EventHandler) => {
    return subscribe('notification:your-turn', handler as SocketHandler)
  }, [subscribe])

  // ─── Kiosk Event Subscriptions ────────────────────────────────────────

  const onKioskUpdate = useCallback((handler: EventHandler) => {
    return subscribe('kiosk:update', handler as SocketHandler)
  }, [subscribe])

  // ─── Agency Event Subscriptions ──────────────────────────────────────

  const onAgencyUpdated = useCallback((handler: EventHandler) => {
    return subscribe('agency:updated', handler as SocketHandler)
  }, [subscribe])

  // ─── Staff Event Subscriptions ───────────────────────────────────────

  const onStaffUpdated = useCallback((handler: EventHandler) => {
    return subscribe('staff:updated', handler as SocketHandler)
  }, [subscribe])

  // ─── Any Event (for debug/logging) ────────────────────────────────────

  const onAnyEvent = useCallback((handler: (...args: unknown[]) => void) => {
    socketRef.current?.onAny(handler)
    return () => {
      socketRef.current?.offAny(handler)
    }
  }, [])

  return {
    // Connection state
    isConnected: connectionStatus === 'connected',
    connectionStatus,

    // Room management
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

    // Generic
    subscribe,
    unsubscribe,
    onAnyEvent,
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
  const { subscribe } = useRealtime()

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
