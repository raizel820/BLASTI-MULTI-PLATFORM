/**
 * @blasti/core — Package Index
 *
 * Re-exports all shared types, adapters, auth, and utilities.
 */

// ─── Types ────────────────────────────────────────────────────────────────
export type {
  SessionUser,
  ApiResponse,
  SyncRecord,
  SyncChanges,
  SyncPullResult,
  SyncPushResult,
  ConflictRecord,
  ConnectionStatus,
  SyncStatus,
  DeviceInfo,
  RealtimeEvent,
} from './types'

// ─── Enums ────────────────────────────────────────────────────────────────
export * from './enums'

// ─── Auth ─────────────────────────────────────────────────────────────────
export {
  createSessionToken,
  verifySessionToken,
  createLocalSessionToken,
  verifyLocalSessionToken,
  getLocalSession,
  clearLocalSession,
  hasLocalSession,
} from './auth'
export type { SessionUser as AuthSessionUser, AuthConfig } from './auth'

// ─── SQLite Adapter ───────────────────────────────────────────────────────
export {
  SqliteDatabase,
  ModelAdapter,
  openDatabase,
} from './sqlite-adapter'
export type {
  WhereClause,
  SelectFields,
  OrderBy,
  QueryOptions,
  CountOptions,
} from './sqlite-adapter'

// ─── Schema ───────────────────────────────────────────────────────────────
export { getCreateTablesSQL, getSyncMigrationSQL, generateId, nowMs } from './schema'

// ─── Config ──────────────────────────────────────────────────────────────
export {
  defaultConfig,
  createConfig,
  isCloudMode,
  isLocalMode,
} from './config'
export type { CoreConfig } from './config'

// ─── Realtime ────────────────────────────────────────────────────────────
export {
  createNullEmitter,
} from './realtime'
export type { RealtimeEmitter } from './realtime'
