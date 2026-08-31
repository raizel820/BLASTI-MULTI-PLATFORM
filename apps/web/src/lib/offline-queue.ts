/**
 * BLASTI Client-Side Offline Queue
 *
 * Provides a persistent queue for offline operations (reservations, etc.)
 * that syncs to the server when connectivity is restored.
 *
 * Architecture:
 *   - Uses IndexedDB for reliable offline storage (large capacity, async)
 *   - Falls back to localStorage if IndexedDB is unavailable
 *   - Listens to online/offline events for automatic sync triggering
 *   - Provides conflict resolution (server wins for conflicts)
 *   - Supports batch sync for efficiency
 *
 * Storage format:
 *   Each queued operation has:
 *   - id: UUID
 *   - type: 'CREATE_RESERVATION' | 'UPDATE_STATUS' | 'RATE' | etc.
 *   - payload: The operation data
 *   - createdAt: ISO timestamp when the operation was created
 *   - syncDeviceId: Device identifier for dedup on server
 *   - retryCount: Number of sync attempts
 *   - lastError: Last error message from failed sync
 *   - status: 'pending' | 'syncing' | 'failed' | 'synced'
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type OfflineOpType =
  | 'CREATE_RESERVATION'
  | 'UPDATE_RESERVATION_STATUS'
  | 'RATE_SERVICE'
  | 'POSTPONE_RESERVATION'
  | 'JOIN_KIOSK_QUEUE';

export interface OfflineOperation {
  id: string;
  type: OfflineOpType;
  payload: Record<string, unknown>;
  createdAt: string;
  syncDeviceId: string;
  retryCount: number;
  lastError?: string;
  status: 'pending' | 'syncing' | 'failed' | 'synced';
}

export interface OfflineQueueStats {
  pendingCount: number;
  failedCount: number;
  syncedCount: number;
  lastSyncAt: string | null;
}

export type SyncEventListener = (event: SyncEvent) => void;

export interface SyncEvent {
  type: 'sync-start' | 'sync-progress' | 'sync-complete' | 'sync-error' | 'op-success' | 'op-failed';
  operation?: OfflineOperation;
  stats?: OfflineQueueStats;
  error?: string;
}

// ─── Device ID ─────────────────────────────────────────────────────────────────

function getDeviceId(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    let deviceId = localStorage.getItem('blasti-device-id');
    if (!deviceId) {
      deviceId = `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('blasti-device-id', deviceId);
    }
    return deviceId;
  } catch {
    return `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ─── Storage Backend (IndexedDB) ──────────────────────────────────────────────

const DB_NAME = 'blasti-offline';
const DB_VERSION = 1;
const STORE_NAME = 'operations';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        // Index for status queries
        db.createIndex('status', 'status', { unique: false });
        db.createIndex('type', 'type', { unique: false });
        db.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withDB<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openDB();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

// ─── Fallback localStorage backend ─────────────────────────────────────────────

const LS_KEY = 'blasti-offline-queue';

function getLSFallback(): OfflineOperation[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setLSFallback(ops: OfflineOperation[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(ops));
  } catch (e) {
    console.warn('[OfflineQueue] localStorage fallback write failed:', e);
  }
}

// ─── Storage Abstraction ───────────────────────────────────────────────────────

let idbAvailable: boolean | null = null;

async function isIndexedDBAvailable(): Promise<boolean> {
  if (idbAvailable !== null) return idbAvailable;
  try {
    if (typeof indexedDB === 'undefined') {
      idbAvailable = false;
      return false;
    }
    const db = await openDB();
    db.close();
    idbAvailable = true;
    return true;
  } catch {
    idbAvailable = false;
    return false;
  }
}

async function getAllOperations(): Promise<OfflineOperation[]> {
  if (await isIndexedDBAvailable()) {
    return withDB(async (db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result as OfflineOperation[]);
        request.onerror = () => reject(request.error);
      });
    });
  }
  return getLSFallback();
}

async function saveAllOperations(ops: OfflineOperation[]): Promise<void> {
  if (await isIndexedDBAvailable()) {
    await withDB(async (db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.clear();
        for (const op of ops) {
          store.put(op);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
  } else {
    setLSFallback(ops);
  }
}

async function addOperation(op: OfflineOperation): Promise<void> {
  if (await isIndexedDBAvailable()) {
    await withDB(async (db) => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(op);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    });
  } else {
    const ops = getLSFallback();
    ops.push(op);
    setLSFallback(ops);
  }
}

async function updateOperation(op: OfflineOperation): Promise<void> {
  await addOperation(op); // Same as add since it uses put (upsert)
}

// ─── UUID Generation ───────────────────────────────────────────────────────────

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// ─── Offline Queue Class ──────────────────────────────────────────────────────

class OfflineQueue {
  private listeners: Set<SyncEventListener> = new Set();
  private isSyncing: boolean = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  /** Get the device identifier */
  readonly deviceId = getDeviceId();

  // ── Event Emitter ──────────────────────────────────────────────────────────

  private emit(event: SyncEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[OfflineQueue] Event listener error:', e);
      }
    }
  }

  onEvent(listener: SyncEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Queue Operations ──────────────────────────────────────────────────────

  /**
   * Add an operation to the offline queue.
   * If online, it will be synced on the next sync cycle.
   */
  async enqueue(type: OfflineOpType, payload: Record<string, unknown>): Promise<OfflineOperation> {
    const operation: OfflineOperation = {
      id: generateId(),
      type,
      payload,
      createdAt: new Date().toISOString(),
      syncDeviceId: this.deviceId,
      retryCount: 0,
      status: 'pending',
    };

    await addOperation(operation);
    this.emit({ type: 'sync-progress', stats: await this.getStats() });

    // Auto-sync if online
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      this.scheduleSync();
    }

    return operation;
  }

  /**
   * Enqueue a reservation creation for offline sync.
   * This is the primary use case for the kiosk and customer apps.
   */
  async enqueueReservation(reservationData: {
    agencyId: string;
    serviceId: string;
    customerName?: string;
    customerPhone?: string;
    notes?: string;
    fixedTimeEnabled?: boolean;
    fixedTime?: string;
    reservedDate?: string;
    preferredTime?: string;
  }): Promise<OfflineOperation> {
    return this.enqueue('CREATE_RESERVATION', {
      ...reservationData,
      offlineCreatedAt: new Date().toISOString(),
      syncDeviceId: this.deviceId,
    });
  }

  // ── Sync Logic ─────────────────────────────────────────────────────────────

  /**
   * Schedule a sync operation with debouncing (5 second delay).
   * Multiple rapid calls will only trigger one sync.
   */
  scheduleSync(delayMs: number = 5000): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync(), delayMs);
  }

  /**
   * Force an immediate sync (bypasses debounce).
   */
  async syncNow(): Promise<OfflineQueueStats> {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    return this.sync();
  }

  /**
   * Sync all pending operations to the server.
   */
  async sync(): Promise<OfflineQueueStats> {
    if (this.isSyncing) return this.getStats();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return this.getStats();
    }

    this.isSyncing = true;
    this.emit({ type: 'sync-start', stats: await this.getStats() });

    try {
      const allOps = await getAllOperations();
      const pending = allOps.filter((op) => op.status === 'pending' || op.status === 'failed');
      let synced = 0;
      let failed = 0;

      for (const op of pending) {
        try {
          op.status = 'syncing';
          await updateOperation(op);

          // Route to the correct endpoint based on operation type
          await this.syncOperation(op);

          op.status = 'synced';
          op.retryCount = 0;
          op.lastError = undefined;
          synced++;
          this.emit({ type: 'op-success', operation: op, stats: await this.getStats() });
        } catch (error) {
          op.retryCount++;
          op.lastError = error instanceof Error ? error.message : String(error);

          // Mark as permanently failed after 5 retries
          if (op.retryCount >= 5) {
            op.status = 'failed';
            failed++;
            this.emit({ type: 'op-failed', operation: op, error: op.lastError, stats: await this.getStats() });
          } else {
            op.status = 'pending'; // Keep as pending for retry
            failed++;
          }
          await updateOperation(op);
        }
      }

      // Clean up synced operations (keep last 50 for history)
      const allOpsAfter = await getAllOperations();
      const syncedOps = allOpsAfter.filter((op) => op.status === 'synced');
      if (syncedOps.length > 50) {
        const toRemove = syncedOps
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
          .slice(0, syncedOps.length - 50);
        await this.removeOperations(toRemove.map((op) => op.id));
      }

      this.emit({ type: 'sync-complete', stats: await this.getStats() });
      return this.getStats();
    } catch (error) {
      this.emit({
        type: 'sync-error',
        error: error instanceof Error ? error.message : String(error),
        stats: await this.getStats(),
      });
      return this.getStats();
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync a single operation to the server.
   */
  private async syncOperation(op: OfflineOperation): Promise<void> {
    switch (op.type) {
      case 'CREATE_RESERVATION': {
        const payload = op.payload as {
          agencyId: string;
          serviceId: string;
          offlineCreatedAt: string;
          syncDeviceId: string;
          customerName?: string;
          customerPhone?: string;
          notes?: string;
        };

        // Use the native session token if available (for Electron/Capacitor)
        const token = typeof localStorage !== 'undefined'
          ? localStorage.getItem('blasti-session-token')
          : null;

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const baseUrl = typeof window !== 'undefined' && window.electronAPI
          ? (process.env.NEXT_PUBLIC_API_URL || 'https://blasti.vercel.app')
          : '';

        const response = await fetch(`${baseUrl}/api/offline-sync`, {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Sync failed with status ${response.status}`);
        }
        break;
      }

      case 'JOIN_KIOSK_QUEUE': {
        const payload = op.payload as {
          agencyCode: string;
          serviceId: string;
          customerName?: string;
          customerPhone?: string;
          notes?: string;
        };

        const baseUrl = typeof window !== 'undefined' && window.electronAPI
          ? (process.env.NEXT_PUBLIC_API_URL || 'https://blasti.vercel.app')
          : '';

        const response = await fetch(`${baseUrl}/api/kiosk/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Kiosk join failed with status ${response.status}`);
        }
        break;
      }

      default:
        throw new Error(`Unknown operation type: ${op.type}`);
    }
  }

  // ── Query Methods ──────────────────────────────────────────────────────────

  async getStats(): Promise<OfflineQueueStats> {
    const allOps = await getAllOperations();
    const pending = allOps.filter((op) => op.status === 'pending' || op.status === 'syncing');
    const failed = allOps.filter((op) => op.status === 'failed');
    const synced = allOps.filter((op) => op.status === 'synced');
    const lastSynced = synced.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    return {
      pendingCount: pending.length,
      failedCount: failed.length,
      syncedCount: synced.length,
      lastSyncAt: lastSynced?.createdAt || null,
    };
  }

  async getPendingCount(): Promise<number> {
    const stats = await this.getStats();
    return stats.pendingCount;
  }

  async getFailedOperations(): Promise<OfflineOperation[]> {
    const allOps = await getAllOperations();
    return allOps.filter((op) => op.status === 'failed');
  }

  // ── Management ─────────────────────────────────────────────────────────────

  async removeOperation(id: string): Promise<void> {
    const allOps = await getAllOperations();
    await saveAllOperations(allOps.filter((op) => op.id !== id));
  }

  async removeOperations(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    const allOps = await getAllOperations();
    await saveAllOperations(allOps.filter((op) => !idSet.has(op.id)));
  }

  async retryFailed(): Promise<OfflineQueueStats> {
    const allOps = await getAllOperations();
    for (const op of allOps) {
      if (op.status === 'failed') {
        op.status = 'pending';
        op.retryCount = 0;
        op.lastError = undefined;
        await updateOperation(op);
      }
    }
    return this.syncNow();
  }

  async clearAll(): Promise<void> {
    if (await isIndexedDBAvailable()) {
      await withDB(async (db) => {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      });
    } else {
      localStorage.removeItem(LS_KEY);
    }
  }

  // ── Online/Offline Listeners ───────────────────────────────────────────────

  /**
   * Start listening for online/offline events to trigger automatic sync.
   * Call this once when the app initializes.
   */
  startAutoSync(): () => void {
    if (typeof window === 'undefined') return () => {};

    const goOnline = () => {
      console.log('[OfflineQueue] Back online — scheduling sync');
      this.scheduleSync(2000); // Sync 2s after coming back online
    };

    const goOffline = () => {
      console.log('[OfflineQueue] Gone offline — pausing sync');
      if (this.syncTimer) {
        clearTimeout(this.syncTimer);
        this.syncTimer = null;
      }
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    // If currently online, sync any pending items
    if (navigator.onLine) {
      this.scheduleSync(3000);
    }

    // Return cleanup function
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      if (this.syncTimer) {
        clearTimeout(this.syncTimer);
        this.syncTimer = null;
      }
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

/**
 * Global offline queue instance.
 * Import this in your app and call `offlineQueue.startAutoSync()` once during init.
 */
export const offlineQueue = new OfflineQueue();
