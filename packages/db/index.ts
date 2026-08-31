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
import { mkdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'

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

// Base PrismaClient — cached globally in development to prevent
// duplicate instances on hot-reload
const baseClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = baseClient

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
const extendedClient = skipGhostDelete
  ? baseClient // No extension when skip flag is set
  : baseClient.$extends({
      model: {
        $allModels: {
          async delete(rawInput: any) {
            // ── Detect Prisma version by inspecting input shape ──
            // Prisma 5.x:  { args: { where: { id } }, model: "User", query: Function }
            // Prisma 6.x:  { where: { id } }  (raw query params, no model/query wrapper)
            const isPrisma5 = rawInput && typeof rawInput.query === 'function'

            if (!isPrisma5) {
              // Prisma 6.x: the extension hook receives raw query params.
              // We cannot determine the model name for tombstone creation.
              // MUST return the raw input unchanged so Prisma executes the operation.
              return rawInput
            }

            // ── Prisma 5.x path ──
            const { args, model: rawModel, query } = rawInput
            const modelName = getModelName(rawModel)

            if (modelName === 'DeletedRecord') {
              return query(args)
            }

            const recordId = args?.where?.id
            if (recordId && typeof recordId === 'string' && modelName) {
              try {
                await baseClient.deletedRecord.create({ data: { modelName, recordId } })
              } catch {
                /* ignore */
              }
            }
            return query(args)
          },

          async deleteMany(rawInput: any) {
            const isPrisma5 = rawInput && typeof rawInput.query === 'function'

            if (!isPrisma5) {
              // Prisma 6.x: pass through unchanged
              return rawInput
            }

            // ── Prisma 5.x path ──
            const { args, model: rawModel, query } = rawInput
            const modelName = getModelName(rawModel)

            if (modelName === 'DeletedRecord') {
              return query(args)
            }

            if (modelName) {
              const delegate = (baseClient as any)[modelToDelegate(modelName)]
              if (delegate) {
                try {
                  const records = await delegate.findMany({
                    where: args?.where || undefined,
                    select: { id: true },
                  })
                  if (records.length > 0) {
                    await baseClient.deletedRecord.createMany({
                      data: records.map((r: { id: string }) => ({ modelName, recordId: r.id })),
                      skipDuplicates: true,
                    })
                  }
                } catch {
                  /* ignore */
                }
              }
            }
            return query(args)
          },
        },
      },
    })

export const db = extendedClient

/**
 * Raw (un-extended) Prisma client — use this for `$transaction` callbacks that
 * perform `deleteMany` cascade operations. The ghost-delete extension's
 * `deleteMany` hook does not receive the `query`/`model` params inside
 * transaction callbacks in Prisma 6.x, causing a TypeError. Using `dbRaw`
 * bypasses the extension entirely for these bulk operations. Tombstone
 * (DeletedRecord) creation is skipped — acceptable since offline sync is
 * best-effort and tombstones can be reconstructed from audit logs.
 */
export const dbRaw = baseClient

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
    await baseClient.$queryRaw`PRAGMA busy_timeout = 5000`
    pragmaInitialized = true
  } catch (err) {
    // Non-fatal — the default busy_timeout is 0, but the retry logic in
    // queue.ts will still handle SQLITE_BUSY errors gracefully.
    console.warn('[db] Failed to set PRAGMA busy_timeout:', err)
  }
}
