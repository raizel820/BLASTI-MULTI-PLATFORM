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
      model: {
        $allModels: {
          async delete(rawInput: any) {
            if (!rawInput || typeof rawInput.query !== 'function') return rawInput
            const { args, model: rawModel, query } = rawInput
            const modelName = getModelName(rawModel)
            if (modelName === 'DeletedRecord') return query(args)
            const recordId = args?.where?.id
            if (recordId && typeof recordId === 'string' && modelName) {
              try { await baseClient.deletedRecord.create({ data: { modelName, recordId } }) } catch { /* */ }
            }
            return query(args)
          },
          async deleteMany(rawInput: any) {
            if (!rawInput || typeof rawInput.query !== 'function') return rawInput
            const { args, model: rawModel, query } = rawInput
            const modelName = getModelName(rawModel)
            if (modelName === 'DeletedRecord') return query(args)
            if (modelName) {
              const delegate = (baseClient as any)[modelToDelegate(modelName)]
              if (delegate) {
                try {
                  const records = await delegate.findMany({ where: args?.where || undefined, select: { id: true } })
                  if (records.length > 0) {
                    await baseClient.deletedRecord.createMany({
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

/**
 * Cloud Prisma client — use this for ALL cloud database access.
 * In production: PostgreSQL. In dev without PG: SQLite via @blasti/db.
 */
export const cloudDb = extendedClient

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
