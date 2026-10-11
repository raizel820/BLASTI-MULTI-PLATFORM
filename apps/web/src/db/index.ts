/**
 * BLASTI WatermelonDB Database — Public API
 *
 * NOTE: Do NOT import from this module in components that run during SSR.
 * The database initialization uses browser-only APIs (LokiJS adapter).
 *
 * For client components, use the React hook instead:
 *   import { useDatabase } from '@/db/provider';
 *
 * For non-React code, use dynamic import:
 *   const { initDatabase } = await import('@/db/client-database');
 *   const db = await initDatabase();
 */

// Re-export types only — safe for SSR
export type { Database } from '@nozbe/watermelondb';

// Re-export sync engine — safe for SSR (uses dynamic imports internally)
export { syncEngine } from './sync';
export type { SyncStatus, SyncEvent } from './sync';

// Re-export model types — safe for SSR (types only)
export type {
  Agency,
  Service,
  Branch,
  Counter,
  Reservation,
  Notification,
  QueueSettings,
} from './models';
