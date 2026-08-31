'use client';

/**
 * BLASTI Reactive Query Hooks
 *
 * These hooks use WatermelonDB's `observe()` / `observeOne()` to create
 * reactive queries that auto-update when the underlying database changes.
 *
 * Usage:
 *   const reservations = useObservableQuery(
 *     (db) => db.get('reservations').query(),
 *     []
 *   );
 */

import { useState, useEffect, useMemo } from 'react';
import type { Database, Query, Model } from '@nozbe/watermelondb';
import { useDatabase } from '@/db/provider';

// ─── useObservableQuery ──────────────────────────────────────────────────────
//
// Subscribes to a WatermelonDB query and re-renders when results change.

export function useObservableQuery<T extends Model>(
  queryFn: (db: Database) => Query<T>,
  deps: any[] = [],
): { data: T[]; isLoading: boolean; error: Error | null } {
  const database = useDatabase();
  const [data, setData] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!database) {
      setIsLoading(false);
      return;
    }

    let subscription: { unsubscribe: () => void } | undefined;
    setIsLoading(true);

    try {
      const query = queryFn(database);
      subscription = query.observe().subscribe({
        next: (records) => {
          setData(records);
          setIsLoading(false);
          setError(null);
        },
        error: (err) => {
          console.error('[useObservableQuery] Error:', err);
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        },
      });
    } catch (err) {
      console.error('[useObservableQuery] Setup error:', err);
      setError(err instanceof Error ? err : new Error(String(err)));
      setIsLoading(false);
    }

    return () => {
      if (subscription) subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database, ...deps]);

  return { data, isLoading, error };
}

// ─── useObservableRecord ─────────────────────────────────────────────────────
//
// Subscribes to a single record by ID and re-renders when it changes.

export function useObservableRecord<T extends Model>(
  tableName: string,
  id: string | null | undefined,
): { data: T | null; isLoading: boolean; error: Error | null } {
  const database = useDatabase();
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!database || !id) {
      setData(null);
      setIsLoading(false);
      return;
    }

    let subscription: { unsubscribe: () => void } | undefined;
    setIsLoading(true);

    try {
      const collection = database.get<T>(tableName);
      subscription = collection.findAndObserve(id).subscribe({
        next: (record) => {
          setData(record);
          setIsLoading(false);
          setError(null);
        },
        error: (err) => {
          // "not found" is not a fatal error — just show null
          if (String(err).includes('not found')) {
            setData(null);
          } else {
            console.error('[useObservableRecord] Error:', err);
            setError(err instanceof Error ? err : new Error(String(err)));
          }
          setIsLoading(false);
        },
      });
    } catch (err) {
      console.error('[useObservableRecord] Setup error:', err);
      setError(err instanceof Error ? err : new Error(String(err)));
      setIsLoading(false);
    }

    return () => {
      if (subscription) subscription.unsubscribe();
    };
  }, [database, tableName, id]);

  return { data, isLoading, error };
}

// ─── useEnhanced (withObservables-like) ──────────────────────────────────────
//
// Subscribe to an observable and re-render on each emission.

export function useEnhanced<T>(
  observableFactory: () => { subscribe: (observer: { next: (v: T) => void; error: (e: any) => void }) => { unsubscribe: () => void } } | null,
  deps: any[] = [],
): { value: T | null; isLoading: boolean; error: Error | null } {
  const [value, setValue] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const observable = observableFactory();
    if (!observable) {
      setValue(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const subscription = observable.subscribe({
      next: (v) => {
        setValue(v);
        setIsLoading(false);
        setError(null);
      },
      error: (err) => {
        console.error('[useEnhanced] Error:', err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      },
    });

    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { value, isLoading, error };
}
