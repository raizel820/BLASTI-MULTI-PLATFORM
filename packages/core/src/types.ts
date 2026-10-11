/**
 * @blasti/core — Shared Types
 *
 * TypeScript interfaces and types shared between cloud and local modes.
 */

// ─── Session ───────────────────────────────────────────────────────────────

export interface SessionUser {
  id: string
  username: string
  fullName: string
  role: string
  language: string
  avatarUrl: string | null
  agencyId: string | null
}

// ─── API Response ─────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

// ─── Sync Types ────────────────────────────────────────────────────────────

export interface SyncRecord {
  id: string
  _status: 'created' | 'updated' | 'deleted'
  _changedAt: number
}

export interface SyncChanges {
  [tableName: string]: {
    created: Record<string, unknown>[]
    updated: Record<string, unknown>[]
    deleted: string[]
  }
}

export interface SyncPullResult {
  changes: SyncChanges
  timestamp: string
}

export interface SyncPushResult {
  applied: number
  rejected: number
  errors: string[]
}

// ─── Conflict Resolution ──────────────────────────────────────────────────

export interface ConflictRecord {
  id: string
  table: string
  localVersion: Record<string, unknown>
  remoteVersion: Record<string, unknown>
  resolvedAt: number | null
  resolution: 'local' | 'remote' | 'merge' | 'manual' | null
}

// ─── Connection Status ────────────────────────────────────────────────────

export type ConnectionStatus = 'online' | 'offline' | 'syncing' | 'error'

export interface SyncStatus {
  connection: ConnectionStatus
  lastCloudSync: number | null
  lastPullAt: number | null
  lastPushAt: number | null
  pendingUploads: number
  pendingDownloads: number
  conflicts: number
  error: string | null
}

// ─── Device Info ────────────────────────────────────────────────────────────

export interface DeviceInfo {
  id: string
  name: string
  platform: string
  appVersion: string
  lastSeen: number
}

// ─── Realtime Events ─────────────────────────────────────────────────────

export interface RealtimeEvent {
  type: string
  payload: unknown
  rooms?: string[]
  userId?: string
  agencyId?: string
  timestamp: number
}
