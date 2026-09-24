/**
 * @blasti/db — Shared Prisma Client Singleton
 *
 * This is the single source of truth for database access across all
 * workspace packages. Import { db } from '@blasti/db' instead of
 * importing from '@prisma/client' directly.
 *
 * Development-time global caching prevents duplicate PrismaClient
 * instances on hot-reload.
 *
 * ── Ghost Delete Trap ──────────────────────────────────────────────
 * A Prisma Client Extension intercepts every delete() and deleteMany()
 * call and automatically creates a DeletedRecord tombstone. This
 * ensures WatermelonDB offline devices receive the delete row instead
 * of a "ghost" that appears to still exist on the device.
 *
 * ── Skip Mechanism ─────────────────────────────────────────────────
 * Seed scripts and migrations can set SKIP_GHOST_DELETE=1 to bypass
 * tombstone creation during bulk data operations.
 * ───────────────────────────────────────────────────────────────────
 */

import { PrismaClient, Prisma } from '@prisma/client'
import { resolve, dirname } from 'path'
import { mkdirSync, existsSync, statSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { AsyncLocalStorage } from 'async_hooks'

// ── Robust DATABASE_URL resolution ─────────────────────────────────────────
// On a freshly-copied/cloned project there may be no `.env` (it's gitignored),
// or it may point at a stale path whose parent directory doesn't exist. In
// either case Prisma throws "Error code 14: Unable to open the database file"
// and every API write returns HTTP 500 with a generic message — very hard to
// debug from the browser console.
//
// To make a fresh copy work with ZERO configuration, we:
//   1. Compute the canonical DB path: <this-package>/data/custom.db
//   2. Validate the incoming DATABASE_URL (if any) — does its parent dir exist?
//   3. Fall back to the canonical path when invalid/missing.
//   4. Ensure the parent directory exists (mkdirSync recursive).
//   5. Set process.env.DATABASE_URL so Prisma's env() picks it up.
function resolveDatabaseUrl(): string {
  const pkgRoot = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url))
  const canonicalPath = resolve(pkgRoot, 'data', 'custom.db')
  const canonicalUrl = `file:${canonicalPath}`

  const incoming = process.env.DATABASE_URL
  if (incoming) {
    // Prisma SQLite URLs look like `file:/abs/path` or `file:./rel/path`
    const filePath = incoming.startsWith('file:')
      ? resolve(incoming.slice('file:'.length).replace(/^\/(?=[A-Za-z]:)/, ''))
      : resolve(incoming)
    const dir = dirname(filePath)
    if (existsSync(dir)) {
      // Incoming URL is usable — keep it (allows overrides for tests/CI).
      return incoming.startsWith('file:') ? incoming : `file:${filePath}`
    }
    console.warn(`[db] DATABASE_URL points to a non-existent directory: ${dir}. Falling back to canonical path.`)
  }
  return canonicalUrl
}

const resolvedDbUrl = resolveDatabaseUrl()
process.env.DATABASE_URL = resolvedDbUrl
// Ensure the parent directory exists so SQLite can create/open the file.
{
  const filePath = resolvedDbUrl.startsWith('file:')
    ? resolvedDbUrl.slice('file:'.length).replace(/^\/(?=[A-Za-z]:)/, '')
    : resolvedDbUrl
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  }
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createBaseClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

// Base PrismaClient — cached globally in development to prevent
// duplicate instances on hot-reload. Held in `currentBase` (not a const)
// because a full platform reset hot-swaps the client onto the freshly
// recreated database file — see the generation watcher at the bottom.
let currentBase: PrismaClient = globalForPrisma.prisma ?? createBaseClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = currentBase

// P1-6/E3: install the tx-capture context BEFORE the extension reads
// $transaction so interactive transactions get deferred capture.
installTransactionalCaptureContext(currentBase)

/**
 * Convert a Prisma model name to its delegate accessor.
 * e.g. "User" → "user", "SubscriptionPlan" → "subscriptionPlan"
 */
function modelToDelegate(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}

/**
 * Safely extract the model name from the extension hook argument.
 * - Prisma 5.x: `model` is a plain string (e.g. "User")
 * - Prisma 6.x: `model` may be undefined, or an object with `.name`
 */
function getModelName(model: unknown): string | undefined {
  if (typeof model === 'string') return model
  if (model && typeof model === 'object' && 'name' in model && typeof (model as any).name === 'string') {
    return (model as any).name
  }
  return undefined
}

// Skip ghost delete during seed/migration operations
const skipGhostDelete = process.env.SKIP_GHOST_DELETE === '1'

// ── Sync Tracking Hook Registration Point ─────────────────────────────────────
// apps/api (cloud) registers a hook via setSyncQueryHook() at startup to record
// SyncChange entries for every mutation on a synced model. Kept here so the
// shared db package stays dependency-free while providing the interception.
export interface SyncQueryHookEvent {
  model: string
  operation: string
  args: any
  result: any
  /** For delete/deleteMany: FULL records captured before the delete executed. */
  preDeleteRecords: any[] | null
  /** For updateMany: affected records captured BEFORE the bulk update ran
   *  (afterwards only { count } is known — without this the event would be
   *  silently dropped and the change feed would miss the whole updateMany). */
  preUpdateManyRecords: any[] | null
}

type SyncQueryHook = (evt: SyncQueryHookEvent) => Promise<void>

let syncQueryHook: SyncQueryHook | null = null

/** Register the cloud-side sync tracking hook (called once by apps/api). */
export function setSyncQueryHook(fn: SyncQueryHook | null): void {
  syncQueryHook = fn
}

/** Disable sync tracking process-wide (seed scripts, migrations). */
export function setSyncTrackingEnabled(enabled: boolean): void {
  skipSyncTracking = !enabled
}

let skipSyncTracking = process.env.SKIP_SYNC_TRACKING === '1'

/**
 * P1-6/E1: ONLY mutation operations produce SyncChange rows. The historic
 * hook fired for EVERY operation including findFirst/findMany — every read
 * of a tracked model polluted the change feed with phantom "update" rows,
 * burned global sequence numbers, and (via pull's missing-record → delete
 * downgrade) could surface to offline clients as PHANTOM DELETES.
 */
const SYNC_MUTATION_OPERATIONS: Set<string> = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
])

// ── P1-6/E3: interactive-transaction capture deferral ──────────────────────
// Empirically verified (Task 15 audit): inside an interactive $transaction,
// the extension hook fires MID-TRANSACTION and the capture worker writes via
// the raw client on a SEPARATE connection — which blocks on SQLite's single
// writer (the business tx) until the tx timeout expires → P2028, the BUSINESS
// WRITE ROLLS BACK, and the blocked capture then commits a SyncChange for a
// mutation that never happened.
//
// Fix: wrap $transaction so callbacks run inside an AsyncLocalStorage
// context; the hook DEFERS capture events collected during the callback and
// flushes them AFTER the commit resolves. A rolled-back tx discards its
// events (flush never runs) — no deadlock, no phantom capture, and capture
// still happens (post-commit) so the feed stays complete.
interface DeferredSyncEvent {
  model: string
  operation: string
  args: any
  result: any
  preDeleteRecords: any[] | null
  preUpdateManyRecords: any[] | null
}

const txCaptureContext = new AsyncLocalStorage<{ deferred: DeferredSyncEvent[] }>()

function flushDeferredSyncEvents(events: DeferredSyncEvent[]): Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  for (const evt of events) {
    chain = chain.then(() => {
      if (!syncQueryHook) return
      return Promise.resolve()
        .then(() => syncQueryHook!(evt))
        .catch((err) => {
          console.warn(
            `[db] deferred sync-capture failed (${evt.model}.${evt.operation}):`,
            (err as Error)?.message,
          )
        })
    })
  }
  return chain
}

// Patch the BASE client's $transaction BEFORE the extension is created — the
// extended client's $transaction delegates to it, so every interactive tx in
// every consumer (apps/api business routes) gets the deferral context.
function installTransactionalCaptureContext(client: PrismaClient): void {
  const anyClient = client as any
  if (typeof anyClient.$transaction !== 'function') return
  const origTransaction = anyClient.$transaction.bind(client)
  anyClient.$transaction = (...args: any[]) => {
    const deferred: DeferredSyncEvent[] = []
    const runInContext = <T,>(work: () => Promise<T>): Promise<T> =>
      txCaptureContext.run({ deferred }, work)
    // Interactive form: $transaction(async tx => ...)
    if (typeof args[0] === 'function') {
      return runInContext(() =>
        Promise.resolve(
          origTransaction((tx: unknown) => (args[0] as (tx: unknown) => unknown)(tx), ...args.slice(1)),
        )
          .then((res) => flushDeferredSyncEvents(deferred).then(() => res))
          .catch((err) => {
            // Rollback (or tx error): the captured events describe mutations
            // that NEVER HAPPENED — discard them instead of poisoning the feed.
            deferred.length = 0
            throw err
          }),
      )
    }
    // Batch/array form: same deferral context (best-effort — op promises in
    // the array may have been created outside the context; those fall back
    // to the immediate-capture path).
    if (Array.isArray(args[0])) {
      return runInContext(() =>
        Promise.resolve(origTransaction(args[0], ...args.slice(1)))
          .then((res) => flushDeferredSyncEvents(deferred).then(() => res))
          .catch((err) => {
            deferred.length = 0
            throw err
          }),
      )
    }
    return origTransaction(...args)
  }
}

/**
 * The 19 synced models (single source of truth: packages/core/src/sync-registry.ts).
 * Duplicated here as a plain Set because @blasti/db must not import @blasti/core
 * (would create a circular workspace dependency at the type level).
 * Keep in sync with the registry — see packages/core/sync-registry.json.
 */
export const SYNC_TRACKED_MODELS: Set<string> = new Set([
  'Agency',
  'User',
  'AgencyStaff',
  'Service',
  'Branch',
  'Counter',
  'QueueSettings',
  'Reservation',
  'Transaction',
  'SmsSettings',
  'PaymentSettings',
  'Notification',
  'Announcement',
  'GlobalAnnouncement',
  'Review',
  'Favorite',
  'FAQ',
  'SubscriptionPlan',
  'PlanFeature',
])


/**
 * Ghost Delete Trap — Prisma Client Extension ($allModels)
 *
 * Intercepts all delete() and deleteMany() calls and creates a
 * DeletedRecord tombstone for each deleted row so that offline
 * WatermelonDB clients can discover the deletion during sync.
 *
 * - Skips tombstone creation for DeletedRecord model itself (prevents recursion)
 * - For delete(): reads the id from args.where and creates one tombstone
 * - For deleteMany(): first finds matching records, then bulk-creates tombstones
 * - Can be skipped entirely via SKIP_GHOST_DELETE=1 env var
 *
 * NOTE on transaction context: In Prisma 6.x, when delete()/deleteMany() are
 * invoked through the transaction client (`tx`), the `query` callback passed
 * to the extension hook is `undefined`. We detect this and fall back to the
 * baseClient delegate so the operation still executes. Tombstone creation is
 * skipped in that path (the findMany for tombstones would also need to run
 * outside the tx, which is acceptable — tombstones are best-effort).
 */
type GhostDeleteExtensionDef = Parameters<PrismaClient['$extends']>[0]

/**
 * Builds the ghost-delete extension bound to a SPECIFIC base client — the
 * pre-delete / pre-updateMany captures below read through it. Rebuilt on
 * every hot-swap so captures always target the live database file.
 */
function buildGhostDeleteExtension(base: PrismaClient): GhostDeleteExtensionDef {
  return {
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            // ── Sync Tracking Hook ──────────────────────────────────────
            // apps/api registers a hook via setSyncQueryHook() at startup.
            // The hook records SyncChange entries (+ tombstones for deletes)
            // for every MUTATION on a synced model that flows through the
            // extended client.
            //
            // P1-6/E1: reads (findFirst/findMany/count/…) NEVER reach the
            // hook — a read produces no change, and treating a read result
            // as an "update" polluted the feed with phantom rows (and, via
            // pull's missing-record downgrade, phantom deletes).
            //
            // P1-6/E3: operations inside an interactive $transaction are
            // DEFERRED (txCaptureContext) and flushed after commit — a
            // mid-tx capture writes on a second connection, deadlocks the
            // business tx, and can roll the business write back (P2028).
            const isTrackedMutation =
              syncQueryHook !== null &&
              !skipSyncTracking &&
              typeof model === 'string' &&
              SYNC_TRACKED_MODELS.has(model) &&
              SYNC_MUTATION_OPERATIONS.has(operation)

            // For bulk deletes we must capture the affected ids BEFORE the
            // delete executes (they are gone afterwards).
            let preDeleteRecords: any[] | null = null
            if (
              isTrackedMutation &&
              (operation === 'delete' || operation === 'deleteMany')
            ) {
              try {
                const delegate = (base as any)[modelToDelegate(model)]
                if (delegate) {
                  // Full records — agency resolution for the SyncChange needs
                  // fields like agencyId/branchId/userId, not just the id.
                  preDeleteRecords = await delegate.findMany({
                    where: (args as any)?.where || undefined,
                  })
                }
              } catch { /* best-effort */ }
            }

            // For bulk updates the operation result is only { count } — the
            // affected ids would be unknowable afterwards. Capture the records
            // matching the filter BEFORE the update runs so the change feed can
            // emit one per-record 'update' event (mark-read, OCC transitions,
            // credit deductions, batch state sweeps…). Best-effort: if the
            // pre-read fails we fall back to today's behavior (event skipped).
            let preUpdateManyRecords: any[] | null = null
            if (isTrackedMutation && operation === 'updateMany') {
              try {
                const delegate = (base as any)[modelToDelegate(model)]
                if (delegate && (args as any)?.where) {
                  preUpdateManyRecords = await delegate.findMany({
                    where: (args as any).where,
                  })
                }
              } catch { /* best-effort */ }
            }

            const result = await query(args)

            if (isTrackedMutation) {
              const evt = { model, operation, args, result, preDeleteRecords, preUpdateManyRecords }
              const txStore = txCaptureContext.getStore()
              if (txStore) {
                // Inside an interactive transaction — DEFER until commit.
                txStore.deferred.push(evt)
              } else {
                try {
                  await syncQueryHook!(evt)
                } catch (err) {
                  console.warn(`[db] sync-tracking hook failed (${model}.${operation}):`, (err as Error)?.message)
                }
              }
            }

            return result
          },
        },
      },
    }
}

// The live client pair. `db` / `dbRaw` below are PROXIES that always forward
// to these — the generation watcher at the bottom of this file swaps them
// after a platform reset.
const initialGhostExtension = skipGhostDelete ? null : buildGhostDeleteExtension(currentBase)
let currentExtended: PrismaClient = initialGhostExtension
  ? (currentBase.$extends(initialGhostExtension) as unknown as PrismaClient)
  : currentBase

// ── Live client proxies (Task 36) ──────────────────────────────────────────
// A PrismaClient opened BEFORE a full platform reset keeps reading the
// DELETED database file through its open handle (the classic unlink
// stale-inode trap) while `prisma db push` + seed recreate the file at the
// same path. These proxies let the generation watcher swap every consumer
// onto a freshly-opened client WITHOUT restarting the process —
// `import { db } from '@blasti/db'` keeps working everywhere, unchanged.

function liveClientProxy(getClient: () => PrismaClient): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get(_target, prop) {
      const client = getClient() as any
      const value = Reflect.get(client, prop, client)
      // Bind top-level methods ($transaction, $queryRaw, $disconnect…) to
      // the CURRENT client so extracted/unbound references stay correct.
      return typeof value === 'function' ? value.bind(client) : value
    },
  })
}

export const db = liveClientProxy(() => currentExtended)

/**
 * Raw (un-extended) Prisma client — use this for `$transaction` callbacks that
 * perform `deleteMany` cascade operations. The ghost-delete extension's
 * `deleteMany` hook does not receive the `query`/`model` params inside
 * transaction callbacks in Prisma 6.x, causing a TypeError. Using `dbRaw`
 * bypasses the extension entirely for these bulk operations. Tombstone
 * (DeletedRecord) creation is skipped — acceptable since offline sync is
 * best-effort and tombstones can be reconstructed from audit logs.
 */
export const dbRaw = liveClientProxy(() => currentBase)

// Re-export Prisma namespace for type access (Prisma.TransactionWhereInput, etc.)
export { Prisma, PrismaClient }

// Default export for convenience
export default db

// ── SQLite PRAGMA Setup ──────────────────────────────────────────────────────
// Phase 3b: Set busy_timeout to 5000ms so SQLite waits (instead of immediately
// failing with SQLITE_BUSY) when another writer holds the lock. This MUST be
// called once at server startup before any concurrent writes occur.

let pragmaInitialized = false

export async function setupSQLitePragmas(): Promise<void> {
  if (pragmaInitialized) return
  try {
    // Use $runCommandRaw or raw query with proper handling for SQLite PRAGMA
    // $executeRawUnsafe returns results which SQLite doesn't allow, so we use $queryRaw instead
    await currentBase.$queryRaw`PRAGMA busy_timeout = 5000`
    pragmaInitialized = true
  } catch (err) {
    // Non-fatal — the default busy_timeout is 0, but the retry logic in
    // queue.ts will still handle SQLITE_BUSY errors gracefully.
    console.warn('[db] Failed to set PRAGMA busy_timeout:', err)
  }
}

// ── Reset-generation invalidation + DB hot-swap (Task 36) ───────────────────
// scripts/reset-all.ts writes .db-generation.json NEXT to the database file:
//   phase 1 (old DB file deleted):  { "epoch": <ms>, "ready": false }
//   phase 2 (db push + seed done):  { "epoch": <ms>, "ready": true  }
//
// 1) apps/api/src/lib/auth.ts calls getInvalidationEpochMs() on EVERY session
//    verification and rejects any JWT whose `iat` predates the epoch — a
//    platform reset kills ALL pre-reset tokens/sessions IMMEDIATELY, even
//    while the API was still serving the deleted file through its old handle.
// 2) The watcher below hot-swaps the Prisma client onto the freshly
//    recreated database file, so the RUNNING process starts serving the NEW
//    data without a restart (the old client drains for 10s, disconnects).

const DB_GENERATION_FILE = (() => {
  const dbPath = resolvedDbUrl.startsWith('file:')
    ? resolvedDbUrl.slice('file:'.length).replace(/^\/(?=[A-Za-z]:)/, '')
    : resolvedDbUrl
  return resolve(dirname(dbPath), '.db-generation.json')
})()

export interface DbGeneration {
  epoch: number
  ready: boolean
}

const generationCache: { mtimeMs: number; gen: DbGeneration | null } = { mtimeMs: -1, gen: null }

function readDbGeneration(): DbGeneration | null {
  try {
    const stat = statSync(DB_GENERATION_FILE)
    if (stat.mtimeMs === generationCache.mtimeMs) return generationCache.gen
    const raw = JSON.parse(readFileSync(DB_GENERATION_FILE, 'utf8')) as Partial<DbGeneration>
    const gen: DbGeneration | null =
      raw && typeof raw.epoch === 'number' && Number.isFinite(raw.epoch)
        ? { epoch: raw.epoch, ready: raw.ready === true }
        : null
    generationCache.mtimeMs = stat.mtimeMs
    generationCache.gen = gen
    return gen
  } catch {
    generationCache.mtimeMs = -1
    generationCache.gen = null
    return null
  }
}

// Sticky + monotonic: once a reset epoch is observed it stays in force even if
// the marker file is later deleted — pre-reset tokens can never be resurrected.
let invalidationEpoch: number | null = readDbGeneration()?.epoch ?? null

/** Epoch (ms) of the latest observed database reset, or null if none ever. */
export function getInvalidationEpochMs(): number | null {
  const gen = readDbGeneration()
  if (gen && (invalidationEpoch === null || gen.epoch > invalidationEpoch)) {
    invalidationEpoch = gen.epoch
  }
  return invalidationEpoch
}

// If this process booted AFTER a completed reset it already opened the fresh
// file — record that generation as applied so the watcher does not re-swap.
const initialGeneration = readDbGeneration()
let lastAppliedGeneration: number | null = initialGeneration?.ready ? initialGeneration.epoch : null

function swapDbClient(): void {
  const previousBase = currentBase
  const base = createBaseClient()
  installTransactionalCaptureContext(base)
  const extension = skipGhostDelete ? null : buildGhostDeleteExtension(base)
  currentBase = base
  currentExtended = extension ? (base.$extends(extension) as unknown as PrismaClient) : base
  if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = base
  // Re-apply connection PRAGMAs on the new client and release the old file
  // handle after in-flight operations drain (best-effort).
  pragmaInitialized = false
  void setupSQLitePragmas().catch(() => {})
  const drain = setTimeout(() => {
    previousBase.$disconnect().catch(() => {})
  }, 10_000)
  if (typeof drain.unref === 'function') drain.unref()
  console.log(`[db] Prisma client hot-swapped onto database generation ${lastAppliedGeneration}`)
}

function startDbGenerationWatcher(): void {
  // One-shot scripts (seed/migrations) and explicitly opted-out processes
  // never need the swap.
  if (process.env.BLASTI_DISABLE_DB_GENERATION_WATCH === '1') return
  if (skipGhostDelete) return
  const timer = setInterval(() => {
    try {
      const gen = readDbGeneration()
      if (gen?.ready && gen.epoch > (lastAppliedGeneration ?? Number.NEGATIVE_INFINITY)) {
        lastAppliedGeneration = gen.epoch
        swapDbClient()
      }
    } catch (err) {
      console.warn('[db] db-generation watcher error:', (err as Error)?.message)
    }
  }, 1000)
  if (typeof timer.unref === 'function') timer.unref()
}

startDbGenerationWatcher()
