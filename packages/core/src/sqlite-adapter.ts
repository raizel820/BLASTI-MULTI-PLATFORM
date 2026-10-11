/**
 * @blasti/core — SQLite Database Adapter
 *
 * Provides a Prisma-like async API backed by better-sqlite3.
 * Used by the embedded local API in Electron.
 *
 * Design: Each model gets a ModelAdapter with async find/create/update/delete
 * methods. Queries are built by converting Prisma-style where/select/include
 * objects into parameterized SQL.
 */

import Database from 'better-sqlite3'
import { getCreateTablesSQL, generateId, nowMs } from './schema'
import type BetterSqlite3 from 'better-sqlite3'

// ─── Types ────────────────────────────────────────────────────────────────

export type WhereClause = Record<string, unknown>
export type SelectFields = Record<string, true> | null
export type OrderBy = { field: string; direction?: 'asc' | 'desc' }

export interface QueryOptions {
  where?: WhereClause
  select?: SelectFields
  include?: Record<string, boolean>
  orderBy?: OrderBy | OrderBy[]
  skip?: number
  take?: number
}

export interface CountOptions {
  where?: WhereClause
}

// ─── camelCase ↔ snake_case Conversion ────────────────────────────────────

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

function rowToCamelCase(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    result[toCamelCase(key)] = value
  }
  return result
}

function rowsToCamelCase(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(rowToCamelCase)
}

// ─── SQL Builder ──────────────────────────────────────────────────────────

/**
 * Convert a where clause object into SQL conditions and parameter values.
 * Supports: equality, null checks, basic operators.
 */
function buildWhereClause(where: WhereClause): { sql: string; params: unknown[] } {
  if (!where || Object.keys(where).length === 0) {
    return { sql: '1=1', params: [] }
  }

  const conditions: string[] = []
  const params: unknown[] = []

  for (const [key, value] of Object.entries(where)) {
    const col = toSnakeCase(key)

    if (value === null || value === undefined) {
      conditions.push(`${col} IS NULL`)
    } else if (typeof value === 'object' && 'contains' in (value as Record<string, unknown>)) {
      conditions.push(`${col} LIKE ?`)
      params.push(`%${(value as { contains: string }).contains}%`)
    } else if (typeof value === 'object' && 'in' in (value as Record<string, unknown>)) {
      const values = (value as { in: unknown[] }).in
      if (values.length === 0) {
        conditions.push('1=0')
      } else {
        const placeholders = values.map(() => '?').join(', ')
        conditions.push(`${col} IN (${placeholders})`)
        params.push(...values)
      }
    } else if (typeof value === 'object' && 'gt' in (value as Record<string, unknown>)) {
      conditions.push(`${col} > ?`)
      params.push((value as { gt: unknown }).gt)
    } else if (typeof value === 'object' && 'gte' in (value as Record<string, unknown>)) {
      conditions.push(`${col} >= ?`)
      params.push((value as { gte: unknown }).gte)
    } else if (typeof value === 'object' && 'lt' in (value as Record<string, unknown>)) {
      conditions.push(`${col} < ?`)
      params.push((value as { lt: unknown }).lt)
    } else if (typeof value === 'object' && 'lte' in (value as Record<string, unknown>)) {
      conditions.push(`${col} <= ?`)
      params.push((value as { lte: unknown }).lte)
    } else if (typeof value === 'object' && 'not' in (value as Record<string, unknown>)) {
      conditions.push(`${col} != ?`)
      params.push((value as { not: unknown }).not)
    } else {
      conditions.push(`${col} = ?`)
      params.push(value)
    }
  }

  return { sql: conditions.join(' AND '), params }
}

/**
 * Build SELECT column list from select fields or default to *.
 */
function buildSelectClause(select: SelectFields, tableName: string): string {
  if (!select) return `"${tableName}".*`
  const cols = Object.keys(select).map((key) => toSnakeCase(key))
  return cols.join(', ')
}

/**
 * Build ORDER BY clause.
 */
function buildOrderBy(orderBy: OrderBy | OrderBy[] | undefined): string {
  if (!orderBy) return ''
  const orders = Array.isArray(orderBy) ? orderBy : [orderBy]
  const clauses = orders.map((o) => {
    const col = toSnakeCase(o.field)
    const dir = o.direction?.toUpperCase() || 'ASC'
    return `${col} ${dir}`
  })
  return ` ORDER BY ${clauses.join(', ')}`
}

// ─── Model Adapter ───────────────────────────────────────────────────────

export class ModelAdapter {
  constructor(
    private db: Database.Database,
    private tableName: string,
    private idField: string = 'id',
  ) {}

  async findUnique(opts: { where: WhereClause; select?: SelectFields }): Promise<Record<string, unknown> | null> {
    const { sql: whereSql, params } = buildWhereClause(opts.where)
    const selectSql = buildSelectClause(opts.select, this.tableName)
    const sql = `SELECT ${selectSql} FROM "${this.tableName}" WHERE ${whereSql} LIMIT 1`
    const row = this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined
    return row ? rowToCamelCase(row) : null
  }

  async findFirst(opts: QueryOptions = {}): Promise<Record<string, unknown> | null> {
    const { sql: whereSql, params } = buildWhereClause(opts.where || {})
    const selectSql = buildSelectClause(opts.select, this.tableName)
    const orderBy = buildOrderBy(opts.orderBy)
    const sql = `SELECT ${selectSql} FROM "${this.tableName}" WHERE ${whereSql}${orderBy} LIMIT 1`
    const row = this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined
    return row ? rowToCamelCase(row) : null
  }

  async findMany(opts: QueryOptions = {}): Promise<Record<string, unknown>[]> {
    const { sql: whereSql, params } = buildWhereClause(opts.where || {})
    const selectSql = buildSelectClause(opts.select, this.tableName)
    const orderBy = buildOrderBy(opts.orderBy)
    let sql = `SELECT ${selectSql} FROM "${this.tableName}" WHERE ${whereSql}${orderBy}`
    if (opts.skip) sql += ` LIMIT ? OFFSET ?`
    else if (opts.take) sql += ` LIMIT ?`

    let queryArgs = [...params]
    if (opts.take && opts.skip) {
      queryArgs.push(opts.take, opts.skip)
    } else if (opts.take) {
      queryArgs.push(opts.take)
    } else if (opts.skip) {
      queryArgs.push(1000000, opts.skip)
    }

    const rows = this.db.prepare(sql).all(...queryArgs) as Record<string, unknown>[]
    return rowsToCamelCase(rows)
  }

  async count(opts: CountOptions = {}): Promise<number> {
    const { sql: whereSql, params } = buildWhereClause(opts.where || {})
    const sql = `SELECT COUNT(*) as count FROM "${this.tableName}" WHERE ${whereSql}`
    const row = this.db.prepare(sql).get(...params) as { count: number }
    return row.count
  }

  async create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = nowMs()

    // Ensure ID exists
    if (!data.id) {
      data = { ...data, id: generateId() }
    }

    // Set timestamps if not provided
    if (!data.createdAt) data.createdAt = now
    if (!data.updatedAt) data.updatedAt = now

    const columns: string[] = []
    const values: unknown[] = []
    const placeholders: string[] = []

    for (const [key, value] of Object.entries(data)) {
      columns.push(toSnakeCase(key))
      values.push(value)
      placeholders.push('?')
    }

    const sql = `INSERT INTO "${this.tableName}" (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`
    this.db.prepare(sql).run(...values)

    // Fetch the created record
    const row = this.db.prepare(`SELECT * FROM "${this.tableName}" WHERE id = ?`).get(data.id) as Record<string, unknown>
    return rowToCamelCase(row)
  }

  async update(opts: { where: WhereClause; data: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const now = nowMs()
    const updateData = { ...opts.data, updatedAt: now }

    const setClauses: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(updateData)) {
      setClauses.push(`${toSnakeCase(key)} = ?`)
      values.push(value)
    }

    const { sql: whereSql, params: whereParams } = buildWhereClause(opts.where)
    const sql = `UPDATE "${this.tableName}" SET ${setClauses.join(', ')} WHERE ${whereSql}`
    this.db.prepare(sql).run(...values, ...whereParams)

    // Fetch the updated record
    const row = this.db.prepare(`SELECT * FROM "${this.tableName}" WHERE id = ?`).get(
      (opts.where as Record<string, unknown>)[this.idField],
    ) as Record<string, unknown>
    return rowToCamelCase(row)
  }

  async updateMany(opts: { where: WhereClause; data: Record<string, unknown> }): Promise<number> {
    const now = nowMs()
    const updateData = { ...opts.data, updatedAt: now }

    const setClauses: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(updateData)) {
      setClauses.push(`${toSnakeCase(key)} = ?`)
      values.push(value)
    }

    const { sql: whereSql, params: whereParams } = buildWhereClause(opts.where)
    const sql = `UPDATE "${this.tableName}" SET ${setClauses.join(', ')} WHERE ${whereSql}`
    const result = this.db.prepare(sql).run(...values, ...whereParams)
    return result.changes
  }

  async delete(opts: { where: WhereClause }): Promise<Record<string, unknown>> {
    const { sql: whereSql, params } = buildWhereClause(opts.where)
    // Fetch first for return
    const row = this.db.prepare(`SELECT * FROM "${this.tableName}" WHERE ${whereSql} LIMIT 1`).get(...params) as Record<string, unknown> | undefined
    this.db.prepare(`DELETE FROM "${this.tableName}" WHERE ${whereSql}`).run(...params)
    return row ? rowToCamelCase(row) : { count: 0 }
  }

  async deleteMany(opts: { where: WhereClause }): Promise<number> {
    const { sql: whereSql, params } = buildWhereClause(opts.where)
    const result = this.db.prepare(`DELETE FROM "${this.tableName}" WHERE ${whereSql}`).run(...params)
    return result.changes
  }

  /**
   * Execute a raw SQL query and return rows.
   */
  async $queryRaw<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const rows = this.db.prepare(sql).all(...params) as T[]
    return rows.map((row) => rowToCamelCase(row as Record<string, unknown>)) as unknown as T[]
  }

  /**
   * Execute a raw SQL statement (no return).
   */
  async $executeRaw(sql: string, ...params: unknown[]): Promise<void> {
    this.db.prepare(sql).run(...params)
  }

  // ─── Sync-aware CRUD methods ──────────────────────────────────────────

  /**
   * Create a record with sync metadata auto-set.
   * Like create() but also sets _version = 1, _deviceId = deviceId.
   */
  async syncCreate(data: Record<string, unknown>, deviceId: string): Promise<Record<string, unknown>> {
    const now = nowMs()

    // Ensure ID exists
    if (!data.id) {
      data = { ...data, id: generateId() }
    }

    // Set timestamps if not provided
    if (!data.createdAt) data.createdAt = now
    if (!data.updatedAt) data.updatedAt = now

    // Set sync columns
    data._version = 1
    data._deviceId = deviceId
    data._deletedAt = null

    const columns: string[] = []
    const values: unknown[] = []
    const placeholders: string[] = []

    for (const [key, value] of Object.entries(data)) {
      columns.push(toSnakeCase(key))
      values.push(value)
      placeholders.push('?')
    }

    const sql = `INSERT INTO "${this.tableName}" (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`
    this.db.prepare(sql).run(...values)

    // Fetch the created record
    const row = this.db.prepare(`SELECT * FROM "${this.tableName}" WHERE id = ?`).get(data.id) as Record<string, unknown>
    return rowToCamelCase(row)
  }

  /**
   * Update a record with version-based conflict detection (last-write-wins).
   *
   * If the incoming data has _version and it matches the stored version,
   * the update is applied and version is incremented.
   * If there is a version mismatch, the update is still applied (last-write-wins)
   * but the returned object includes conflict: true.
   * If no incoming _version, just apply (trust local edits).
   */
  async syncUpdate(
    opts: { where: WhereClause; data: Record<string, unknown> },
    deviceId: string,
  ): Promise<{ record: Record<string, unknown>; conflict: boolean }> {
    const now = nowMs()

    // Fetch the current stored record
    const { sql: whereSql, params: whereParams } = buildWhereClause(opts.where)
    const stored = this.db.prepare(
      `SELECT * FROM "${this.tableName}" WHERE ${whereSql} LIMIT 1`,
    ).get(...whereParams) as Record<string, unknown> | undefined

    if (!stored) {
      throw new Error(`Record not found in ${this.tableName}`)
    }

    const storedVersion = stored._version as number | undefined ?? 1
    const incomingVersion = opts.data._version as number | undefined

    // Determine if there is a conflict
    let conflict = false
    if (incomingVersion !== undefined && incomingVersion !== storedVersion) {
      conflict = true
    }

    // Apply the update (last-write-wins)
    const newVersion = (incomingVersion ?? storedVersion) + 1
    const updateData = {
      ...opts.data,
      _version: newVersion,
      _deviceId: deviceId,
      updatedAt: now,
    }
    // Don't re-write _version and _deviceId from the incoming data if they were
    // already set by us above — remove them from opts.data spread to avoid override
    delete updateData._version
    delete updateData._deviceId
    updateData._version = newVersion
    updateData._deviceId = deviceId

    const setClauses: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(updateData)) {
      // Skip _version / _deviceId / _deletedAt that come from incoming data —
      // we already set them explicitly above
      if (key === '_version' || key === '_deviceId') {
        setClauses.push(`${toSnakeCase(key)} = ?`)
        values.push(value)
        continue
      }
      setClauses.push(`${toSnakeCase(key)} = ?`)
      values.push(value)
    }

    // Deduplicate setClauses (in case opts.data also had _version/_deviceId)
    const seen = new Set<string>()
    const uniqueClauses: string[] = []
    const uniqueValues: unknown[] = []
    for (let i = 0; i < setClauses.length; i++) {
      if (!seen.has(setClauses[i])) {
        seen.add(setClauses[i])
        uniqueClauses.push(setClauses[i])
        uniqueValues.push(values[i])
      }
    }

    const updateSql = `UPDATE "${this.tableName}" SET ${uniqueClauses.join(', ')} WHERE ${whereSql}`
    this.db.prepare(updateSql).run(...uniqueValues, ...whereParams)

    // Fetch the updated record
    const id = (opts.where as Record<string, unknown>).id ?? stored.id
    const row = this.db.prepare(
      `SELECT * FROM "${this.tableName}" WHERE id = ?`,
    ).get(id) as Record<string, unknown>

    return { record: rowToCamelCase(row), conflict }
  }

  /**
   * Get all changes since a given version/timestamp for incremental sync.
   *
   * @param sinceVersion - Only return records with _version > this value
   * @param agencyId   - Optional filter by agencyId column
   * @returns Categorized changes: created, updated, deleted (array of IDs)
   */
  async getChangesSince(
    sinceVersion: number,
    agencyId?: string,
  ): Promise<{ created: Record<string, unknown>[]; updated: Record<string, unknown>[]; deleted: string[] }> {
    let baseWhere = '_version > ?'
    const params: unknown[] = [sinceVersion]

    if (agencyId) {
      baseWhere += ' AND agencyId = ?'
      params.push(agencyId)
    }

    // Fetch all changed rows
    const rows = this.db.prepare(
      `SELECT * FROM "${this.tableName}" WHERE ${baseWhere} ORDER BY _version ASC`,
    ).all(...params) as Record<string, unknown>[]

    const created: Record<string, unknown>[] = []
    const updated: Record<string, unknown>[] = []
    const deleted: string[] = []

    for (const row of rows) {
      const camelRow = rowToCamelCase(row)
      if (row._deletedAt !== null && row._deletedAt !== undefined) {
        // Tombstoned record
        deleted.push(row.id as string)
      } else if (row._version === 1) {
        // Version 1 means it was created (never updated)
        created.push(camelRow)
      } else {
        updated.push(camelRow)
      }
    }

    return { created, updated, deleted }
  }

  /**
   * Soft-delete a record by setting _deletedAt and incrementing _version.
   * Does NOT actually remove the row — the record becomes a tombstone.
   */
  async softDelete(where: WhereClause, deviceId: string): Promise<Record<string, unknown>> {
    const now = nowMs()

    const { sql: whereSql, params: whereParams } = buildWhereClause(where)

    // Increment _version, set _deletedAt and _deviceId
    const updateSql = `UPDATE "${this.tableName}" SET _deletedAt = ?, _version = _version + 1, _deviceId = ?, updatedAt = ? WHERE ${whereSql}`
    this.db.prepare(updateSql).run(now, deviceId, now, ...whereParams)

    // Fetch the soft-deleted record
    const row = this.db.prepare(
      `SELECT * FROM "${this.tableName}" WHERE ${whereSql} LIMIT 1`,
    ).get(...whereParams) as Record<string, unknown> | undefined

    return row ? rowToCamelCase(row) : { count: 0 }
  }
}

// ─── Database Client ────────────────────────────────────────────────────────

export class SqliteDatabase {
  private db: Database.Database
  private _inTransaction = false

  // Model adapters — lazy initialized
  private _adapters = new Map<string, ModelAdapter>()

  constructor(dbPath: string) {
    this.db = new Database(dbPath)

    // Enable WAL mode and performance pragmas
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')

    // Create all tables
    const sql = getCreateTablesSQL()
    this.db.exec(sql)
  }

  /** Get the raw better-sqlite3 instance for advanced operations. */
  get raw(): Database.Database {
    return this.db
  }

  /** Get a model adapter for the given table name. */
  model(name: string): ModelAdapter {
    if (!this._adapters.has(name)) {
      this._adapters.set(name, new ModelAdapter(this.db, name))
    }
    return this._adapters.get(name)!
  }

  // Convenience model accessors (camelCase → PascalCase table names)
  get user() { return this.model('User') }
  get agency() { return this.model('Agency') }
  get service() { return this.model('Service') }
  get branch() { return this.model('Branch') }
  get counter() { return this.model('Counter') }
  get reservation() { return this.model('Reservation') }
  get notification() { return this.model('Notification') }
  get queueSettings() { return this.model('QueueSettings') }
  get agencyStaff() { return this.model('AgencyStaff') }
  get review() { return this.model('Review') }
  get auditLog() { return this.model('AuditLog') }
  get favorite() { return this.model('Favorite') }
  get announcement() { return this.model('Announcement') }
  get transaction() { return this.model('Transaction') }
  get deletedRecord() { return this.model('DeletedRecord') }
  get systemSetting() { return this.model('SystemSetting') }
  get faq() { return this.model('FAQ') }
  get subscriptionPlan() { return this.model('SubscriptionPlan') }
  get deviceRegistration() { return this.model('DeviceRegistration') }

  /**
   * Execute a callback inside a SQLite transaction.
   * Wraps the synchronous better-sqlite3 transaction in a Promise.
   */
  async $transaction<T>(fn: (db: SqliteDatabase) => Promise<T>): Promise<T> {
    if (this._inTransaction) {
      // Already in a transaction — just run the callback
      return fn(this)
    }

    this._inTransaction = true
    const transaction = this.db.transaction(async () => {
      return await fn(this)
    })

    try {
      return await transaction()
    } finally {
      this._inTransaction = false
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close()
  }
}

/**
 * Open a SQLite database and initialize the schema.
 */
export function openDatabase(dbPath: string): SqliteDatabase {
  return new SqliteDatabase(dbPath)
}
