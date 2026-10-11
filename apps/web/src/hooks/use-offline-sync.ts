/**
 * useOfflineSync — React hook for WatermelonDB-based offline sync
 *
 * Uses dynamic imports for all WatermelonDB code to avoid SSR bundling issues.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { syncEngine, type SyncStatus, type SyncEvent } from '@/db/sync';

interface UseOfflineSyncReturn {
  pendingCount: number;
  isSyncing: boolean;
  status: SyncStatus;
  syncNow: () => Promise<void>;
}

export function useOfflineSync(): UseOfflineSyncReturn {
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [status, setStatus] = useState<SyncStatus>({
    lastSync: null,
    isSyncing: false,
    pendingChanges: 0,
    lastError: null,
  });

  useEffect(() => {
    const handler = (event: SyncEvent) => {
      if (event.type === 'sync-start') {
        setIsSyncing(true);
      } else if (event.type === 'sync-complete' || event.type === 'sync-error') {
        setIsSyncing(false);
      }
      if (event.status) {
        setStatus(event.status);
      }
    };

    const unsubscribe = syncEngine.onEvent(handler);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const refreshStats = async () => {
      // Dynamic import to avoid SSR bundling of WatermelonDB
      const { getOfflineStats } = await import('@/lib/offline-layer');
      const stats = await getOfflineStats();
      setPendingCount(stats.pendingReservations);
      setStatus(syncEngine.getStatus());
    };

    refreshStats();
    const interval = setInterval(refreshStats, 30000);
    return () => clearInterval(interval);
  }, []);

  const syncNow = useCallback(async () => {
    // Dynamic import — only loads WDB on the client
    // CRITICAL FIX: Use initDatabase() (async) instead of getDatabase() (sync).
    const { initDatabase } = await import('@/db/client-database');
    const db = await initDatabase();
    if (!db) return;
    await syncEngine.sync(db);
    const { getOfflineStats } = await import('@/lib/offline-layer');
    const stats = await getOfflineStats();
    setPendingCount(stats.pendingReservations);
  }, []);

  return {
    pendingCount,
    isSyncing,
    status,
    syncNow,
  };
}
