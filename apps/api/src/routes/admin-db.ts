/**
 * @blasti/api — Database Manager Routes (SUPER_ADMIN only)
 *
 * Full PostgreSQL administration console backing the admin sidebar
 * "Database Manager" section:
 *
 *   GET    /tables                     → every table with live row counts + sizes
 *   GET    /table/:name                → paginated row browser (search + sort)
 *   GET    /table/:name/export         → CSV download of the table
 *   DELETE /table/:name/row/:id        → delete a single row
 *   GET    /stats                      → database overview (size, version, cache)
 *   POST   /maintenance/vacuum         → VACUUM ANALYZE (bloat + stats refresh)
 *   POST   /maintenance/tombstones     → purge offline-sync tombstones older than N days
 *
 * SAFETY MODEL
 *   - Every route requires SUPER_ADMIN (requireAdmin).
 *   - Table and column names are validated against information_schema
 *     (identifier whitelist) BEFORE any SQL is built; user VALUES are
 *     always bound parameters — never interpolated.
 *   - Only tables in the public schema are reachable.
 *   - Deletes run through raw SQL (bypasses the Prisma Ghost Delete Trap
 *     extension deliberately — tombstones are NOT created for admin
 *     manual deletes, matching the documented deleteConfig precedent).
 */

import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAdmin, authErrorResponse } from '../lib/auth'

const app = new Hono()

// ─── Identifier safety ──────────────────────────────────────────────────────

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Quote a validated identifier for use in raw SQL.
 * The input MUST already match IDENT_RE (call assertSafeIdentifier first).
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Resolve and validate a table name against the live PostgreSQL catalog.
 * Returns the quoted identifier or null when the table does not exist.
 */
async function resolveTable(rawName: string): Promise<string | null> {
  if (!IDENT_RE.test(rawName)) return null
  const results = await db.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${rawName}
    ) AS exists`
  if (!results[0]?.exists) return null
  return quoteIdent(rawName)
}

/**
 * List the (validated) column names of a public-schema table.
 */
async function tableColumns(tableName: string): Promise<Array<{ name: string; dataType: string }>> {
  const rows = await db.$queryRaw<Array<{ column_name: string; data_type: string }>>`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${tableName}
    ORDER BY ordinal_position`
  return rows.map((r) => ({ name: r.column_name, dataType: r.data_type }))
}

/** Format bytes into a human-readable string. */
function humanSize(bytes: number | bigint | string | null | undefined): string {
  const n = Number(bytes ?? 0)
  if (!n || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// ─── GET /tables — list every table with counts + sizes ────────────────────

app.get('/tables', async (c) => {
  try {
    await requireAdmin(c)

    const tables = await db.$queryRaw<Array<{
      table_name: string
      total_size: bigint
      row_estimate: bigint
    }>>`
      SELECT
        c.relname AS table_name,
        pg_total_relation_size(c.oid) AS total_size,
        GREATEST(c.reltuples, 0)::bigint AS row_estimate
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
      ORDER BY pg_total_relation_size(c.oid) DESC`

    // Exact row counts (the catalog estimate goes stale after writes).
    // Bounded concurrency keeps this fast even with many tables.
    const result: Array<{
      name: string
      rowCount: number
      sizeBytes: number
      size: string
    }> = []

    const CONCURRENCY = 8
    for (let i = 0; i < tables.length; i += CONCURRENCY) {
      const chunk = tables.slice(i, i + CONCURRENCY)
      const counts = await Promise.all(
        chunk.map(async (t) => {
          if (!IDENT_RE.test(t.table_name)) return 0
          try {
            const rows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
              `SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(t.table_name)}`
            )
            return Number(rows[0]?.count ?? 0)
          } catch {
            return Number(t.row_estimate)
          }
        })
      )
      chunk.forEach((t, idx) => {
        result.push({
          name: t.table_name,
          rowCount: counts[idx],
          sizeBytes: Number(t.total_size),
          size: humanSize(t.total_size),
        })
      })
    }

    return c.json({ success: true, data: result })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /table/:name — paginated row browser ──────────────────────────────

app.get('/table/:name', async (c) => {
  try {
    await requireAdmin(c)

    const tableName = c.req.param('name')
    const table = await resolveTable(tableName)
    if (!table) {
      return c.json({ success: false, error: 'Table not found' }, 404)
    }

    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1)
    const pageSize = Math.min(100, Math.max(5, parseInt(c.req.query('pageSize') || '25', 10) || 25))
    const search = (c.req.query('search') || '').trim()
    const orderByRaw = c.req.query('orderBy') || 'createdAt'
    const orderDir = c.req.query('orderDir') === 'asc' ? 'ASC' : 'DESC'

    const columns = await tableColumns(tableName)
    if (columns.length === 0) {
      return c.json({ success: false, error: 'Table has no columns' }, 400)
    }

    // Sort column must exist on the table; fall back to the primary-ish
    // candidates so the SQL is always valid.
    let orderBy = orderByRaw
    if (!IDENT_RE.test(orderBy) || !columns.some((col) => col.name === orderBy)) {
      const preferred = ['createdAt', 'created_at', 'id']
      orderBy = columns.find((col) => preferred.includes(col.name))?.name || columns[0].name
    }

    // Search: case-insensitive ILIKE across every text-ish column.
    const textColumns = columns
      .filter((col) => ['text', 'character varying', 'character', 'citext'].includes(col.dataType))
      .map((col) => quoteIdent(col.name))
    let whereSql = ''
    const params: unknown[] = []
    if (search && textColumns.length > 0) {
      const clauses = textColumns.map((col) => `${col}::text ILIKE $1`)
      whereSql = `WHERE ${clauses.join(' OR ')}`
      params.push(`%${search}%`)
    }

    const totalRows = await db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM ${table} ${whereSql}`,
      ...params
    )
    const total = Number(totalRows[0]?.count ?? 0)
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(page, totalPages)

    const offset = (safePage - 1) * pageSize
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM ${table} ${whereSql} ORDER BY ${quoteIdent(orderBy)} ${orderDir} NULLS LAST LIMIT ${pageSize} OFFSET ${offset}`,
      ...params
    )

    return c.json({
      success: true,
      data: {
        table: tableName,
        columns: columns.map((col) => ({ name: col.name, dataType: col.dataType })),
        rows: rows.map((row) => serializeRow(row)),
        pagination: {
          page: safePage,
          pageSize,
          total,
          totalPages,
        },
        orderBy,
        orderDir: orderDir.toLowerCase(),
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /table/:name/export — CSV download ────────────────────────────────

app.get('/table/:name/export', async (c) => {
  try {
    await requireAdmin(c)

    const tableName = c.req.param('name')
    const table = await resolveTable(tableName)
    if (!table) {
      return c.json({ success: false, error: 'Table not found' }, 404)
    }

    const MAX_EXPORT_ROWS = 50000
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM ${table} LIMIT ${MAX_EXPORT_ROWS}`
    )
    if (rows.length === 0) {
      return c.json({ success: false, error: 'Table is empty — nothing to export' }, 400)
    }

    const headers = Object.keys(rows[0])
    const escapeCsv = (val: unknown): string => {
      if (val === null || val === undefined) return ''
      const s = val instanceof Date ? val.toISOString() : typeof val === 'object' ? JSON.stringify(val) : String(val)
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
      return s
    }

    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((h) => escapeCsv(row[h])).join(',')),
    ].join('\n')

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="blasti-${tableName}-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── DELETE /table/:name/row/:id — delete one row ──────────────────────────

app.delete('/table/:name/row/:id', async (c) => {
  try {
    await requireAdmin(c)

    const tableName = c.req.param('name')
    const rowId = c.req.param('id')
    if (!rowId || rowId.length > 255) {
      return c.json({ success: false, error: 'Invalid row id' }, 400)
    }

    const table = await resolveTable(tableName)
    if (!table) {
      return c.json({ success: false, error: 'Table not found' }, 404)
    }

    const columns = await tableColumns(tableName)
    const hasId = columns.some((col) => col.name === 'id')
    if (!hasId) {
      return c.json({ success: false, error: 'Table has no id column — row delete is not supported' }, 400)
    }

    const deleted = await db.$executeRawUnsafe(
      `DELETE FROM ${table} WHERE ${quoteIdent('id')} = $1`,
      rowId
    )
    if (deleted === 0) {
      return c.json({ success: false, error: 'Row not found' }, 404)
    }

    return c.json({ success: true, message: `Deleted 1 row from ${tableName}`, data: { deleted } })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /stats — database overview ────────────────────────────────────────

app.get('/stats', async (c) => {
  try {
    await requireAdmin(c)

    const [info] = await db.$queryRaw<Array<{
      version: string
      db_size: bigint
      tables: bigint
      active_connections: bigint
    }>>`
      SELECT
        version() AS version,
        pg_database_size(current_database()) AS db_size,
        (SELECT COUNT(*) FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r') AS tables,
        (SELECT COUNT(*) FROM pg_stat_activity
          WHERE datname = current_database()) AS active_connections`

    const [usage] = await db.$queryRaw<Array<{
      size_bytes: bigint
      blocks_read: bigint
      blocks_hit: bigint
      transactions: bigint
      cache_hit_ratio: number | null
    }>>`
      SELECT
        pg_database_size(current_database()) AS size_bytes,
        (SELECT blks_read FROM pg_stat_database WHERE datname = current_database()) AS blocks_read,
        (SELECT blks_hit FROM pg_stat_database WHERE datname = current_database()) AS blocks_hit,
        (SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()) AS transactions,
        (SELECT ROUND(blks_hit::numeric / NULLIF(blks_hit + blks_read, 0), 4)
          FROM pg_stat_database WHERE datname = current_database()) AS cache_hit_ratio`

    const blocksRead = Number(usage?.blocks_read ?? 0)
    const blocksHit = Number(usage?.blocks_hit ?? 0)

    return c.json({
      success: true,
      data: {
        version: info?.version?.split(' ')[0] + ' ' + (info?.version?.split(' ')[1] ?? ''),
        fullVersion: info?.version,
        databaseSize: humanSize(info?.db_size),
        databaseSizeBytes: Number(info?.db_size ?? 0),
        tableCount: Number(info?.tables ?? 0),
        activeConnections: Number(info?.active_connections ?? 0),
        transactionsCommitted: Number(usage?.transactions ?? 0),
        blocksFetched: blocksHit + blocksRead,
        cacheHitRatio: usage?.cache_hit_ratio != null ? Number(usage.cache_hit_ratio) : null,
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── POST /maintenance/vacuum — VACUUM ANALYZE ─────────────────────────────

app.post('/maintenance/vacuum', async (c) => {
  try {
    await requireAdmin(c)

    const startedAt = Date.now()
    // VACUUM cannot run inside a transaction block — $queryRawUnsafe issues
    // it as a simple query, which is what we need.
    await db.$queryRawUnsafe('VACUUM ANALYZE')
    const durationMs = Date.now() - startedAt

    return c.json({
      success: true,
      message: 'VACUUM ANALYZE completed',
      data: { durationMs },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── POST /maintenance/tombstones — purge old sync tombstones ──────────────

app.post('/maintenance/tombstones', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json().catch(() => ({}))
    const days = Math.max(1, Math.min(365, parseInt(body?.days ?? '30', 10) || 30))

    const deleted = await db.$executeRawUnsafe(
      `DELETE FROM "DeletedRecord" WHERE "deletedAt" < NOW() - INTERVAL '${days} days'`
    )

    return c.json({
      success: true,
      message: `Purged ${deleted} tombstone(s) older than ${days} day(s)`,
      data: { deleted, days },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Make a raw PostgreSQL row JSON-safe:
 *   - bigint → number (Prisma returns BigInt for int8 columns)
 *   - Date   → ISO string
 *   - Buffer → '<binary N bytes>' (never leak raw bytes)
 */
function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') {
      out[key] = Number(value)
    } else if (value instanceof Date) {
      out[key] = value.toISOString()
    } else if (Buffer.isBuffer(value)) {
      out[key] = `<binary ${value.length} bytes>`
    } else {
      out[key] = value
    }
  }
  return out
}

export const adminDbRoutes = app
