/**
 * BLASTI — IndexedDB reset helper (shared by every "wipe app data" surface).
 *
 * PRODUCTION FIX ("Deleting database failed because it's blocked by another
 * connection"): the three recovery surfaces (global-error, root-recovery
 * boundary, mobile diagnostics sheet) issued BARE indexedDB.deleteDatabase()
 * calls with NO event handlers — while the app's own LokiJS/WatermelonDB
 * singleton (and any second tab) still held the connection. The unhandled
 * `blocked`/`error` DOM events surfaced as console errors (21 tracked hits in
 * 7 days) and the delete silently never completed.
 *
 * This helper: (1) best-effort CLOSES the live database singleton first
 * (loki.close() + worker terminate — the same internals the adapter's own
 * testClone uses), then (2) issues the delete WITH full onblocked/onerror/
 * onsuccess handlers and a bounded wait, so callers can react honestly.
 */

/** The single canonical client database name (keep in sync with client-database.ts). */
export const APP_IDB_NAME = 'blasti-watermelondb';

/** Best-effort close of the live WatermelonDB/Loki singleton — never throws. */
export async function closeClientDatabase(): Promise<void> {
  try {
    const { getDatabase } = await import('@/db/client-database');
    const database = getDatabase() as unknown as {
      adapter?: {
        _driver?: { loki?: { close?: () => void } };
        _dispatcher?: { _worker?: { terminate?: () => void } };
      } | null;
    } | null;
    const adapter = database?.adapter;
    if (!adapter) return;
    // useWebWorker:false in this app, but keep the worker path for safety.
    try { adapter._dispatcher?._worker?.terminate?.(); } catch { /* ignore */ }
    try { adapter._driver?.loki?.close?.(); } catch { /* ignore */ }
  } catch { /* client-database unavailable (SSR/bundle) — nothing to close */ }
}

export type IdbDeleteOutcome = 'deleted' | 'blocked' | 'error' | 'unsupported';

/**
 * Delete the app's IndexedDB database with FULL event handling.
 * Resolves (never rejects) with the outcome so recovery UIs can log honestly.
 * `timeoutMs` bounds the wait — IndexedDB has no built-in deadline.
 */
export async function deleteAppIndexedDb(timeoutMs: number = 4000): Promise<IdbDeleteOutcome> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.deleteDatabase !== 'function') {
    return 'unsupported';
  }
  await closeClientDatabase();
  return new Promise<IdbDeleteOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: IdbDeleteOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('blocked'), timeoutMs);
    try {
      const req = indexedDB.deleteDatabase(APP_IDB_NAME);
      req.onsuccess = () => finish('deleted');
      req.onerror = () => finish('error');
      req.onblocked = () => finish('blocked'); // a second tab/connection holds the DB
    } catch {
      finish('error');
    }
  });
}
