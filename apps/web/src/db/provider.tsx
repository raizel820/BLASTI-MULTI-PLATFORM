'use client';

/**
 * BLASTI Database Provider
 *
 * Initializes the WatermelonDB database on the client and provides it
 * to all child components via React context. Also starts the periodic
 * sync engine automatically.
 *
 * IMPORTANT: WatermelonDB and its LokiJS adapter use browser-only APIs
 * (IndexedDB, WebWorker, etc.). This provider uses dynamic imports to
 * ensure the database is only loaded on the client, never during SSR.
 */

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import type { Database } from '@nozbe/watermelondb';
import { syncEngine } from '@/db/sync';

interface DatabaseContextValue {
  database: Database | null;
  isReady: boolean;
}

const DatabaseContext = createContext<DatabaseContextValue>({
  database: null,
  isReady: false,
});

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const [database, setDatabase] = useState<Database | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    // Dynamically import the database module ONLY on the client.
    // This prevents Turbopack from trying to bundle WatermelonDB's
    // browser-only LokiJS adapter for the server.
    let mounted = true;

    import('@/db/client-database').then(({ initDatabase }) => {
      if (!mounted) return;
      // CRITICAL FIX: Use initDatabase() (async) instead of getDatabase() (sync).
      // getDatabase() was returning null because initDatabase() hadn't completed yet,
      // which meant: database stayed null, isReady stayed false, sync engine never started,
      // and no data was ever synced to WatermelonDB — causing the offline mode to fail.
      initDatabase().then((db) => {
        if (!mounted) return;
        setDatabase(db);
        setIsReady(true);

        // Start periodic sync (every 5 minutes)
        // Also syncs on initial load and when coming back online
        const cleanup = syncEngine.startPeriodicSync(db);
        return cleanup;
      }).catch((err) => {
        console.error('[DatabaseProvider] Failed to initialize WatermelonDB:', err);
      });
    }).catch((err) => {
      console.error('[DatabaseProvider] Failed to import database module:', err);
    });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <DatabaseContext.Provider value={{ database, isReady }}>
      {children}
    </DatabaseContext.Provider>
  );
}

export function useDatabase(): Database | null {
  const { database } = useContext(DatabaseContext);
  return database;
}

export function useDatabaseReady(): boolean {
  const { isReady } = useContext(DatabaseContext);
  return isReady;
}
