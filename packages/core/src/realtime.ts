/**
 * @blasti/core — Realtime Event Emitter Interface
 *
 * Abstracts Socket.IO for both cloud (real Socket.IO server) and local
 * (in-process EventEmitter or local Socket.IO) modes.
 */

import type { RealtimeEvent } from './types'

export interface RealtimeEmitter {
  /**
   * Emit an event to specific rooms.
   */
  emit(event: RealtimeEvent): void

  /**
   * Emit an event to all connected clients in a room.
   */
  emitToRoom(room: string, eventName: string, payload: unknown): void

  /**
   * Get the number of connected clients.
   */
  getClientCount(): number
}

/**
 * Create a no-op emitter for testing or when realtime is not needed.
 */
export function createNullEmitter(): RealtimeEmitter {
  return {
    emit() {},
    emitToRoom() {},
    getClientCount() {
      return 0
    },
  }
}
