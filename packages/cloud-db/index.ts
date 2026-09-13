/**
 * @blasti/cloud-db — Cloud Database Prisma Client Singleton
 *
 * This is the single source of truth for Cloud database access.
 * Import { cloudDb } from '@blasti/cloud-db' instead of importing
 * from the generated client directly.
 *
 * ── Runtime Behavior ──────────────────────────────────────────────
 * Production (CLOUD_DATABASE_URL set to postgresql://...):
 *   → Uses PostgreSQL Prisma client (from ./generated/cloud-client)
 *   → Startup assertion verifies provider = postgresql
 *
 * Development (CLOUD_DATABASE_URL NOT set):
 *   → Falls back to @blasti/db (SQLite Prisma client)
 *   → This allows local development without a PostgreSQL server
 *   → Logs a warning that PostgreSQL is not configured
 *
 * ── Environment ────────────────────────────────────────────────────
 * CLOUD_DATABASE_URL — PostgreSQL connection string (production)
 * DATABASE_URL — SQLite connection string (development fallback)
 * ───────────────────────────────────────────────────────────────────
 */

const cloudDbUrl = process.env.CLOUD_DATABASE_URL || ''
const isDevMode = process.env.NODE_ENV !== 'production'
const isPostgresUrl = cloudDbUrl.startsWith('postgresql://') || cloudDbUrl.startsWith('postgres://')

// ── Startup Assertion: Verify PostgreSQL in production ───────────────────────
if (process.env.NODE_ENV === 'production' && (!cloudDbUrl || !isPostgresUrl)) {
  throw new Error(
    `FATAL: CLOUD_DATABASE_URL must point to PostgreSQL in production. ` +
    `Got: ${cloudDbUrl ? cloudDbUrl.substring(0, 30) + '...' : '(not set)'}`
  )
}

// ── Client Selection ────────────────────────────────────────────────────────
// In dev without PostgreSQL: use @blasti/db (SQLite) as a transparent fallback.
// The schemas are structurally identical, so the API surface is the same.

let baseClient: any
let Prisma: any
let usingPostgreSQL = isPostgresUrl

if (isPostgresUrl) {
  // ── PostgreSQL mode (production or dev with PostgreSQL) ──
  try {
    const pgModule = require('./generated/cloud-client')
    const PgPrismaClient = pgModule.PrismaClient
    Prisma = pgModule.Prisma

    const globalForPrisma = globalThis as unknown as { cloudPrisma: any }
    baseClient =
      globalForPrisma.cloudPrisma ??
      new PgPrismaClient({
        log: isDevMode ? ['warn', 'error'] : ['error'],
        datasources: { db: { url: cloudDbUrl } },
      })
    if (isDevMode) globalForPrisma.cloudPrisma = baseClient

    console.log(`[cloud-db] Connected to PostgreSQL: ${cloudDbUrl.replace(/:[^:@]+@/, ':****@')}`)
  } catch (err: any) {
    throw new Error(`FATAL: Failed to initialize PostgreSQL client: ${err.message}`)
  }
} else {
  // ── SQLite fallback mode (development without PostgreSQL) ──
  try {
    const sqliteModule = require('@blasti/db')
    baseClient = sqliteModule.db
    Prisma = sqliteModule.Prisma
    usingPostgreSQL = false

    console.warn(
      '[cloud-db] ⚠ CLOUD_DATABASE_URL not set — using SQLite fallback for development.\n' +
      '  Set CLOUD_DATABASE_URL=postgresql://user:pass@host:5432/db for real PostgreSQL.'
    )
  } catch (err: any) {
    throw new Error(
      `FATAL: Cannot initialize cloud DB. PostgreSQL not configured and SQLite fallback failed: ${err.message}`
    )
  }
}

// ── Ghost Delete Trap ───────────────────────────────────────────────────────
// Only apply the extension when using the PostgreSQL client directly.
// The @blasti/db SQLite client already has its own ghost delete trap.
// For the PG client, we wrap delete/deleteMany to create DeletedRecord tombstones.
//
// NOTE (Task 3-b): rewritten to the DOCUMENTED `query` component API. The
// previous implementation used the undocumented Prisma 5 `model` component
// internal shape ({ args, model, query }); under Prisma 6+ the override
// receives raw args, returns them unchanged, and the delete NEVER EXECUTES
// (verified empirically — deletes were silent no-ops). The query component
// works across Prisma 5/6/7.

function modelToDelegate(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}

function getModelName(model: unknown): string | undefined {
  if (typeof model === 'string') return model
  if (model && typeof model === 'object' && 'name' in model && typeof (model as any).name === 'string') {
    return (model as any).name
  }
  return undefined
}

const skipGhostDelete = process.env.SKIP_GHOST_DELETE === '1'

// Only extend the PG client with ghost delete trap (SQLite already has it)
let extendedClient = baseClient
if (usingPostgreSQL && !skipGhostDelete) {
  try {
    extendedClient = baseClient.$extends({
      query: {
        $allModels: {
          async delete({ args, model, query }: { args: any; model: any; query: (args: any) => Promise<any> }) {
            const modelName = getModelName(model)
            if (modelName === 'DeletedRecord') return query(args)
            const recordId = args?.where?.id
            if (recordId && typeof recordId === 'string' && modelName) {
              try { await (baseClient as any).deletedRecord.create({ data: { modelName, recordId } }) } catch { /* */ }
            }
            return query(args)
          },
          async deleteMany({ args, model, query }: { args: any; model: any; query: (args: any) => Promise<any> }) {
            const modelName = getModelName(model)
            if (modelName === 'DeletedRecord') return query(args)
            if (modelName) {
              const delegate = (baseClient as any)[modelToDelegate(modelName)]
              if (delegate) {
                try {
                  const records = await delegate.findMany({ where: args?.where || undefined, select: { id: true } })
                  if (records.length > 0) {
                    await (baseClient as any).deletedRecord.createMany({
                      data: records.map((r: { id: string }) => ({ modelName, recordId: r.id })),
                      skipDuplicates: true,
                    })
                  }
                } catch { /* */ }
              }
            }
            return query(args)
          },
        },
      },
    })
  } catch (e) {
    // Extension failed — use base client
    console.warn('[cloud-db] Ghost delete trap extension failed:', (e as Error).message)
    extendedClient = baseClient
  }
}

// ── SyncChange Auto-Recording (Task 3-b / D2) ────────────────────────────────
// Cloud-originated business writes (web/QR joins, admin edits, cron sweeps)
// previously never recorded a SyncChange row, so /api/sync/pull could only
// ever deliver echoes of desktop pushes. This extension records a SyncChange
// AFTER every successful single-record create/update/upsert/delete on a model
// in the sync set.
//
// Rules (Task 2-c audit fix D2):
//   - Sync set mirrors SYNC_MODELS in apps/api/src/routes/sync.ts (19 models).
//     (@blasti/core is not a dependency of this package, so the list is kept
//     here with a comment matching sync.ts — do not diverge.)
//   - Infrastructure models (SyncChange, SyncMutation, SyncCursor,
//     DeletedRecord, AgencyLocalState, DelayedJob, AuditLog, ...) are excluded
//     implicitly because they are not in the sync set.
//   - *Many operations are skipped (deleteMany is already covered by the
//     ghost-delete trap writing DeletedRecord tombstones).
//   - agencyId is derived from the written record; models without an agencyId
//     column (User, Notification, GlobalAnnouncement, PlanFeature, SmsSettings,
//     PaymentSettings, FAQ — verified against the Prisma schema) are skipped
//     safely, except User which is resolved via an AgencyStaff lookup, Counter
//     which is resolved via its branch, and SubscriptionPlan which uses
//     ownerAgencyId when set.
//   - The insert runs on the RAW base client (no extension) AND checks the
//     model name, so it can never recurse into itself.
//   - Failures are logged and swallowed — a SyncChange recording failure must
//     NEVER break the business write.

// Mirrors SYNC_MODELS in apps/api/src/routes/sync.ts — keep in sync.
const CLOUD_SYNC_MODELS: ReadonlySet<string> = new Set([
  'Agency', 'Service', 'Branch', 'Counter', 'Reservation', 'Notification',
  'QueueSettings', 'AgencyStaff', 'Review', 'User',
  // ── 9 models added for full sync coverage (Task 2a) ──────────────────────
  'SmsSettings', 'PaymentSettings', 'Announcement', 'GlobalAnnouncement',
  'Transaction', 'SubscriptionPlan', 'PlanFeature', 'Favorite', 'FAQ',
])

// Models whose cloud-originated writes cannot be attributed to an agency
// (no agencyId column in the Prisma schema) — skipped safely by the hook.
const NO_AGENCY_ID_MODELS: ReadonlySet<string> = new Set([
  'Notification',       // scoped by userId only
  'GlobalAnnouncement', // global, no agency scoping
  'PlanFeature',        // scoped via plan only (plan may be global)
  'SmsSettings',        // global settings table
  'PaymentSettings',    // global settings table
  'FAQ',                // global content table
])

// eslint-disable-next-line @typescript-eslint/no-var-requires
const asyncHooks: { AsyncLocalStorage: new <T>() => { run<R>(store: T, cb: (...args: any[]) => R, ...args: any[]): R; getStore(): T | undefined } } = require('node:async_hooks')
const { AsyncLocalStorage } = asyncHooks

// Suppression scope: push-processing (sync-helpers.atomicMutation /
// withIdempotency) already records SyncChange explicitly via
// recordSyncChange(); the auto-hook must stay silent inside that flow to
// avoid double/triple rows. Scoped with AsyncLocalStorage so concurrent
// requests never suppress each other.
const autoSyncChangeSuppression = new AsyncLocalStorage<boolean>()

export async function suppressAutoSyncChange<T>(fn: () => Promise<T>): Promise<T> {
  return autoSyncChangeSuppression.run(true, fn)
}

function isAutoSyncChangeSuppressed(): boolean {
  return autoSyncChangeSuppression.getStore() === true
}

/**
 * Create a SyncChange row with correct sequence assignment.
 *
 * PostgreSQL: `sequence` is `@default(autoincrement())` — plain create works.
 * SQLite fallback: the local schema declares `sequence Int @unique` with NO
 * default (packages/db/prisma/schema.prisma), so the sequence must be
 * assigned manually as max+1 (with a retry on unique-constraint collisions).
 *
 * Safe to call with a transaction client or the raw base client.
 */
export async function createSyncChangeRecord(
  client: any,
  data: { agencyId: string; model: string; recordId: string; operation: string; syncVersion: number; mutationId?: string | null },
): Promise<any> {
  if (usingPostgreSQL) {
    return client.syncChange.create({ data })
  }

  // SQLite fallback — manual monotonic sequence assignment.
  let lastError: unknown = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const agg = await client.syncChange.aggregate({ _max: { sequence: true } })
      const nextSequence = ((agg?._max?.sequence as number | null) ?? 0) + 1
      return await client.syncChange.create({ data: { ...data, sequence: nextSequence } })
    } catch (err: any) {
      lastError = err
      if (err?.code !== 'P2002') throw err // unique-violation → retry; anything else → surface
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
  throw lastError
}

/**
 * Derive the owning agencyId from a written record. Returns null when the
 * agency cannot be determined unambiguously (caller must skip recording).
 */
async function deriveAgencyIdForModel(model: string, result: any): Promise<string | null> {
  if (!result || typeof result !== 'object') return null

  try {
    switch (model) {
      case 'Agency':
        return typeof result.id === 'string' ? result.id : null

      // Direct agencyId column (verified in the Prisma schema)
      case 'Service':
      case 'Branch':
      case 'QueueSettings':
      case 'Reservation':
      case 'Review':
      case 'Announcement':
      case 'AgencyStaff':
      case 'Transaction':
      case 'Favorite':
        return typeof result.agencyId === 'string' && result.agencyId ? result.agencyId : null

      case 'Counter': {
        // Counter has no agencyId — resolve via its (required) branch
        if (typeof result.branchId !== 'string' || !result.branchId) return null
        const branch = await (baseClient as any).branch.findUnique({
          where: { id: result.branchId },
          select: { agencyId: true },
        })
        return branch?.agencyId ?? null
      }

      case 'User': {
        // User has no agencyId — resolve via an active AgencyStaff assignment
        if (typeof result.id !== 'string' || !result.id) return null
        const staff = await (baseClient as any).agencyStaff.findFirst({
          where: { userId: result.id, isActive: true },
          select: { agencyId: true },
        })
        return staff?.agencyId ?? null
      }

      case 'SubscriptionPlan': {
        // Global catalog plans have no agency — only enterprise plans do
        return typeof result.ownerAgencyId === 'string' && result.ownerAgencyId
          ? result.ownerAgencyId
          : null
      }

      default:
        return null
    }
  } catch {
    return null
  }
}

/**
 * Fire-and-forget SyncChange recording used by the query extension hook.
 * Never throws.
 */
async function recordAutoSyncChange(
  model: string,
  operation: 'create' | 'update' | 'upsert' | 'delete',
  result: any,
): Promise<void> {
  try {
    if (!CLOUD_SYNC_MODELS.has(model)) return
    if (NO_AGENCY_ID_MODELS.has(model)) return
    if (isAutoSyncChangeSuppressed()) return

    // Map the operation to the SyncChange vocabulary.
    // upsert can create or update — recording it as 'update' is safe: the
    // desktop apply path inserts when the record is missing locally.
    const syncOperation = operation === 'upsert' ? 'update' : operation
    const recordId = typeof result?.id === 'string' ? result.id : null
    if (!recordId) return

    const agencyId = await deriveAgencyIdForModel(model, result)
    if (!agencyId) return

    const syncVersion = typeof result?.syncVersion === 'number' ? result.syncVersion : 0

    await createSyncChangeRecord(baseClient, {
      agencyId,
      model,
      recordId,
      operation: syncOperation,
      syncVersion,
    })
  } catch (err: any) {
    console.warn(`[cloud-db] Failed to record SyncChange for ${model}:`, err?.message ?? err)
  }
}

// Apply the SyncChange recording extension to BOTH client paths:
//   - PostgreSQL: chained after the ghost-delete trap extension.
//   - SQLite fallback: chained onto the @blasti/db client (which carries its
//     own ghost-delete trap internally).
let syncExtendedClient = extendedClient
try {
  syncExtendedClient = extendedClient.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: { model: any; operation: string; args: any; query: (args: any) => Promise<any> }) {
          const result = await query(args)

          const modelName = getModelName(model)
          if (
            modelName &&
            (operation === 'create' || operation === 'update' || operation === 'upsert' || operation === 'delete') &&
            !isAutoSyncChangeSuppressed()
          ) {
            // Fire-and-forget (NOT awaited): the hook also runs inside
            // interactive transactions, and an awaited SyncChange insert on the
            // base client would contend for SQLite's single write lock while
            // the outer transaction holds it → guaranteed 5s busy-timeout and
            // a P2028 "Transaction already closed" failure (observed on
            // POST /api/agency/queue/walk-in). Recording happens right after
            // commit instead; errors are already swallowed inside.
            void recordAutoSyncChange(modelName, operation as any, result)
          }

          return result
        },
      },
    },
  })
} catch (e) {
  console.warn('[cloud-db] SyncChange recording extension failed:', (e as Error).message)
  syncExtendedClient = extendedClient
}

/**
 * Cloud Prisma client — use this for ALL cloud database access.
 * In production: PostgreSQL. In dev without PG: SQLite via @blasti/db.
 * Carries the ghost-delete trap (PG) and the SyncChange auto-recording hook.
 */
export const cloudDb = syncExtendedClient

/**
 * Raw (un-extended) Prisma client for $transaction callbacks.
 */
export const cloudDbRaw = baseClient

// Re-export Prisma namespace for type access
export { Prisma }

// Default export for convenience
export default cloudDb

// ── PostgreSQL Pragma Setup ─────────────────────────────────────────────────

let pgInitialized = false

export async function setupPostgreSQLPragmas(): Promise<void> {
  if (pgInitialized || !usingPostgreSQL) return
  try {
    await baseClient.$executeRawUnsafe(`SET timezone TO 'UTC'`)
    await baseClient.$executeRawUnsafe(`SET statement_timeout TO 5000`)
    pgInitialized = true
    console.log('[cloud-db] PostgreSQL pragmas set: timezone=UTC, statement_timeout=5s')
  } catch (err) {
    console.warn('[cloud-db] Failed to set PostgreSQL pragmas:', err)
  }
}

/**
 * Check if the cloud DB is currently using PostgreSQL.
 * Useful for conditional logic that differs between dev (SQLite) and prod (PG).
 */
export function isUsingPostgreSQL(): boolean {
  return usingPostgreSQL
}
