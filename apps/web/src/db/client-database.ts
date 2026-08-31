/**
 * BLASTI WatermelonDB Client Database Instance
 *
 * This module is loaded dynamically by the DatabaseProvider ONLY on the client.
 * It must NOT be imported directly by any module that runs on the server.
 *
 * The LokiJS adapter uses browser-only APIs (IndexedDB, localStorage, WebWorker)
 * which would crash if evaluated during SSR.
 */

import type { Database } from '@nozbe/watermelondb';

let _database: Database | null = null;
let _initPromise: Promise<Database> | null = null;

export async function initDatabase(): Promise<Database> {
  if (_database) return _database;

  // If an initialization is already in flight, wait for it instead of
  // starting a second one (prevents duplicate adapter creation).
  if (_initPromise) return _initPromise;

  _initPromise = _doInit().finally(() => {
    _initPromise = null;
  });
  return _initPromise;
}

async function _doInit(): Promise<Database> {
  // Dynamic imports — browser-only code, never loaded during SSR.
  // NOTE: `LokiJSAdapter` is a *default* export of its subpath
  // (`exports.default`), NOT a named export. Destructuring it as a named
  // member yields `undefined` and throws "LokiJSAdapter is not a constructor"
  // at `new LokiJSAdapter(...)`. We must read it via `.default`.
  const [
    { Database: DatabaseClass },
    LokiJSModule,
    { schema },
    { migrations },
    { modelClasses },
  ] = await Promise.all([
    import('@nozbe/watermelondb'),
    import('@nozbe/watermelondb/adapters/lokijs'),
    import('./schema'),
    import('./migrations'),
    import('./models'),
  ]);

  const LokiJSAdapter = (LokiJSModule as { default: typeof import('@nozbe/watermelondb/adapters/lokijs').default }).default;

  const adapter = new LokiJSAdapter({
    dbName: 'blasti-watermelondb',
    schema,
    migrations,
    // `useWebWorker` and `useIncrementalIndexedDB` are required by the
    // adapter's dev-mode invariant (see adapters/lokijs/index.js).
    useWebWorker: false,
    useIncrementalIndexedDB: true,
  });

  _database = new DatabaseClass({
    adapter,
    modelClasses,
    actionsEnabled: true,
  });

  console.log('[WatermelonDB] Database initialized with LokiJS adapter');
  return _database;
}

/**
 * Get the database synchronously. Returns `null` if not yet initialized.
 * For reliable access, prefer `initDatabase()` (async) instead.
 */
export function getDatabase(): Database | null {
  if (typeof window === 'undefined') return null;
  return _database;
}
