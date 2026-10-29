/**
 * @blasti/api — Backup Engine
 *
 * A self-contained, pg_dump-free logical backup system designed for BLASTI:
 *
 *   SNAPSHOT  Every public table is read via raw SQL and serialized into one
 *             gzipped JSON payload (data.json.gz) + an optional files.tar.gz
 *             of the on-disk file store (STORAGE_ROOT). A manifest.json keeps
 *             metadata: per-table row counts + column types, sizes, checksum,
 *             topological insert order, app + Postgres versions.
 *
 *   RESTORE   Atomic: a single transaction TRUNCATEs every table and re-inserts
 *             rows in topological (FK-parent-first) order with per-column
 *             PostgreSQL casts — any failure rolls the database back to its
 *             pre-restore state. Serial sequences are then realigned to
 *             MAX(id). A "pre-restore" safety backup is always created first.
 *             Restores are verified per-table against the manifest counts.
 *
 *   FILES     The files archive is a minimal ustar tarball (no external deps)
 *             compressed with Bun.GzipSync; restore extracts it over
 *             STORAGE_ROOT (never deletes existing files).
 *
 *   STATE     The backup registry, auto-backup settings and external targets
 *             live in <BACKUP_DIR>/state.json — deliberately OUTSIDE the
 *             database so a restore can never destroy the backup history.
 *
 *   SCHEDULE  nextRunAt is persisted so restarts never lose the schedule
 *             (see workers/backup-scheduler.ts).
 */

import fs from 'node:fs'
import path from 'node:path'
import { db } from '@blasti/db'
import { STORAGE_ROOT } from './storage'

// ─── Paths ──────────────────────────────────────────────────────────────────

/**
 * Repo root detection: Bun's __dirname/import.meta.url can resolve through
 * transpile caches, so we walk up from process.cwd() (apps/api) until we hit
 * the monorepo root (the directory that has BOTH apps/ and packages/).
 * BLASTI_BACKUP_DIR always wins when set.
 */
function detectRepoRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    try {
      if (
        fs.existsSync(path.join(dir, 'apps')) &&
        fs.existsSync(path.join(dir, 'packages')) &&
        fs.existsSync(path.join(dir, 'package.json'))
      ) {
        return dir
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

const REPO_ROOT = detectRepoRoot()
export { REPO_ROOT }
export const BACKUP_DIR =
  process.env.BLASTI_BACKUP_DIR || path.join(REPO_ROOT, 'backups')

const STATE_FILE = path.join(BACKUP_DIR, 'state.json')
const DATA_FILE = 'data.json.gz'
const FILES_FILE = 'files.tar.gz'
const MANIFEST_FILE = 'manifest.json'

const APP_VERSION = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ).version as string
  } catch {
    return 'unknown'
  }
})()

// ─── Types ──────────────────────────────────────────────────────────────────

export type BackupType = 'manual' | 'auto' | 'pre-restore'

export interface BackupSettings {
  enabled: boolean
  /** hours between auto backups (6 | 12 | 24 | 168 …) — used when dailyAt is null */
  intervalHours: number | null
  /** alternative: run daily at "HH:mm" (Africa/Algiers) */
  dailyAt: string | null
  /** keep at most N auto backups (oldest deleted) */
  keepLastN: number
  includeFiles: boolean
  /** push every new auto backup to targets with autoPush !== false */
  autoPush: boolean
}

export type TargetType = 's3' | 'azure-blob' | 'd1' | 'postgres'

export interface TargetConfig {
  id: string
  name: string
  type: TargetType
  autoPush: boolean
  createdAt: string
  lastPushAt: string | null
  lastPushResult: 'success' | 'error' | null
  lastPushError: string | null
  // s3 (R2 / AWS / B2 / Minio / any SigV4 endpoint)
  endpoint?: string
  region?: string
  bucket?: string
  accessKeyId?: string
  secretAccessKey?: string
  prefix?: string
  // azure-blob
  account?: string
  container?: string
  accountKey?: string
  sasToken?: string
  // d1
  accountId?: string
  databaseId?: string
  apiToken?: string
  // postgres (Neon / Supabase / RDS / any connection string)
  url?: string
}

export interface TableMeta {
  name: string
  rows: number
  columns: Array<{ name: string; dataType: string; udtName?: string }>
}

export interface BackupManifest {
  id: string
  label: string
  type: BackupType
  createdAt: string
  includeFiles: boolean
  appVersion: string
  pgVersion: string
  dbSizeBytes: number
  tables: TableMeta[]
  /** topological (parents-first) order for restore inserts */
  insertOrder: string[]
  rowCount: number
  dataBytes: number
  filesBytes: number
  filesCount: number
  dataSha256: string
  durationMs: number
}

export interface BackupEntry extends BackupManifest {
  dataFile: string
  filesFile: string | null
}

export interface RunningJob {
  kind: 'backup' | 'restore' | 'push'
  label: string
  startedAt: string
  backupId?: string
  targetName?: string
}

interface BackupState {
  version: 1
  settings: BackupSettings
  targets: TargetConfig[]
  backups: BackupEntry[]
  nextRunAt: string | null
  runningJob: RunningJob | null
}

export const DEFAULT_SETTINGS: BackupSettings = {
  enabled: false,
  intervalHours: 24,
  dailyAt: null,
  keepLastN: 10,
  includeFiles: false,
  autoPush: false,
}

// ─── State (atomic file) ────────────────────────────────────────────────────

let stateCache: BackupState | null = null

function loadState(): BackupState {
  if (stateCache) return stateCache
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      stateCache = {
        version: 1,
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
        targets: Array.isArray(raw.targets) ? raw.targets : [],
        backups: Array.isArray(raw.backups) ? raw.backups : [],
        nextRunAt: raw.nextRunAt ?? null,
        runningJob: raw.runningJob ?? null,
      }
      return stateCache
    } catch {
      // corrupted state — start fresh (backup dirs on disk stay usable)
    }
  }
  stateCache = {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    targets: [],
    backups: [],
    nextRunAt: null,
    runningJob: null,
  }
  return stateCache
}

function writeStateFile(): void {
  if (!stateCache) return
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(stateCache, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}

export function getState(): BackupState {
  return loadState()
}

export function saveState(): void {
  writeStateFile()
}

// ─── Target registry helpers ────────────────────────────────────────────────

export function addTarget(target: TargetConfig): TargetConfig {
  const s = loadState()
  s.targets.push(target)
  writeStateFile()
  return target
}

export function updateTarget(id: string, patch: Partial<TargetConfig>): TargetConfig | null {
  const s = loadState()
  const idx = s.targets.findIndex((t) => t.id === id)
  if (idx === -1) return null
  s.targets[idx] = { ...s.targets[idx], ...patch }
  writeStateFile()
  return s.targets[idx]
}

export function removeTarget(id: string): boolean {
  const s = loadState()
  const before = s.targets.length
  s.targets = s.targets.filter((t) => t.id !== id)
  const removed = s.targets.length < before
  if (removed) writeStateFile()
  return removed
}

// ─── Busy mutex ─────────────────────────────────────────────────────────────

let busy = false

export function isBusy(): boolean {
  return busy || getState().runningJob !== null
}

function setRunningJob(job: RunningJob | null): void {
  const s = loadState()
  s.runningJob = job
  saveState()
}

// ─── JSON encoding (bigint / Decimal / bytes safe) ──────────────────────────

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value !== null && typeof value === 'object') {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name
    if (ctor === 'Decimal') return value.toString()
    if (value instanceof Uint8Array) {
      return { $b64: Buffer.from(value).toString('base64') }
    }
  }
  return value
}

// ─── Table discovery ────────────────────────────────────────────────────────

const EXCLUDED_TABLES = new Set(['_prisma_migrations'])

export interface PublicTable {
  name: string
  rowCount: number
  sizeBytes: number
}

export async function listPublicTables(): Promise<PublicTable[]> {
  const tables = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name`
  const out: PublicTable[] = []
  for (const { table_name } of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table_name)) continue
    if (EXCLUDED_TABLES.has(table_name)) continue
    // NOTE: identifiers are case-sensitive (Prisma created them QUOTED —
    // "User", "VerificationCode"…). Every occurrence must be double-quoted,
    // INCLUDING inside pg_* function arguments (regclass literals), or
    // PostgreSQL folds the name to lowercase and the lookup 42P01s.
    const q = `"${table_name}"`
    const [cnt, size] = await Promise.all([
      db.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT COUNT(*)::bigint AS c FROM ${q}`,
      ),
      db.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT pg_total_relation_size('${q}')::bigint AS c`,
      ),
    ])
    out.push({
      name: table_name,
      rowCount: Number(cnt[0]?.c ?? 0),
      sizeBytes: Number(size[0]?.c ?? 0),
    })
  }
  return out
}

async function getColumns(
  table: string,
): Promise<Array<{ name: string; dataType: string; udtName?: string }>> {
  const cols = await db.$queryRawUnsafe<
    Array<{ column_name: string; data_type: string; udt_name: string }>
  >(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    table,
  )
  return cols.map((c) => ({
    name: c.column_name,
    dataType: c.data_type,
    // native PostgreSQL enums (Prisma enum models) report USER-DEFINED —
    // keep the concrete type name so inserts can cast text → enum
    udtName: c.data_type === 'USER-DEFINED' ? c.udt_name : undefined,
  }))
}

/** Topological order: FK parents before children (Kahn). Cycle-tolerant. */
export async function topoInsertOrder(tables: string[]): Promise<string[]> {
  if (tables.length === 0) return []
  const set = new Set(tables)
  const edges = await db.$queryRawUnsafe<Array<{ child: string; parent: string }>>(
    `SELECT con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent
     FROM pg_constraint con
     JOIN pg_namespace n ON n.oid = con.connamespace
     WHERE con.contype = 'f' AND n.nspname = 'public'`,
  )
  // strip schema prefix and surrounding quotes ("public"."User" → User);
  // regclass::text yields QUOTED identifiers for mixed-case names
  const strip = (s: string) =>
    s
      .replace(/^"public"\./, '')
      .replace(/^public\./, '')
      .replace(/^"/, '')
      .replace(/"$/, '')
  const deps = new Map<string, Set<string>>()
  for (const t of tables) deps.set(t, new Set())
  for (const e of edges) {
    const child = strip(e.child)
    const parent = strip(e.parent)
    if (child !== parent && set.has(child) && set.has(parent)) {
      deps.get(child)!.add(parent)
    }
  }
  const order: string[] = []
  const remaining = new Set(tables)
  while (remaining.size > 0) {
    const ready = [...remaining].filter((t) =>
      [...deps.get(t)!].every((d) => !remaining.has(d)),
    )
    const batch = (ready.length > 0 ? ready : [...remaining]).sort()
    for (const t of batch) {
      order.push(t)
      remaining.delete(t)
    }
  }
  return order
}

// ─── Minimal ustar tar (no external deps) ───────────────────────────────────

function tarHeader(name: string, size: number, mtime: Date, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(512)
  const write = (s: string, off: number, len: number) => {
    Buffer.from(s, 'utf8').copy(h, off, 0, Math.min(Buffer.byteLength(s), len))
  }
  let prefix = ''
  let fileName = name
  if (Buffer.byteLength(name, 'utf8') > 100) {
    const idx = name.lastIndexOf('/', name.length - 101)
    prefix = name.slice(0, idx)
    fileName = name.slice(idx + 1)
  }
  write(fileName, 0, 100)
  write('0000644\0', 100, 8) // mode
  write('0000000\0', 108, 8) // uid
  write('0000000\0', 116, 8) // gid
  write(size.toString(8).padStart(11, '0') + '\0', 124, 12)
  write(Math.floor(mtime.getTime() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12)
  h.fill('0', 148, 156) // checksum placeholder
  h[156] = type.charCodeAt(0)
  write('ustar\0', 257, 6)
  write('00', 263, 2)
  write(prefix, 345, 155)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += h[i]
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return h
}

function createTar(files: Array<{ rel: string; abs: string; size: number; mtime: Date }>, dirs: string[]): Buffer {
  const chunks: Buffer[] = []
  for (const d of dirs.sort()) {
    chunks.push(tarHeader(d.endsWith('/') ? d : d + '/', 0, new Date(), '5'))
    chunks.push(Buffer.alloc(512 - (((0 + 511) % 512) + 1)))
  }
  for (const f of files) {
    const content = fs.readFileSync(f.abs)
    chunks.push(tarHeader(f.rel, content.length, f.mtime, '0'))
    chunks.push(content)
    const pad = (512 - (content.length % 512)) % 512
    if (pad > 0) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024)) // end-of-archive
  return Buffer.concat(chunks)
}

export function createFilesArchive(sourceDir: string, outPath: string): { bytes: number; count: number } {
  const files: Array<{ rel: string; abs: string; size: number; mtime: Date }> = []
  const dirs: string[] = []
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        dirs.push(relPath)
        walk(abs, relPath)
      } else if (e.isFile()) {
        let st: fs.Stats
        try {
          st = fs.statSync(abs)
        } catch {
          continue
        }
        files.push({ rel: relPath, abs, size: st.size, mtime: st.mtime })
      }
    }
  }
  walk(sourceDir, '')
  const tar = createTar(files, dirs)
  const gz = Bun.gzipSync(tar)
  fs.writeFileSync(outPath, gz)
  return { bytes: gz.length, count: files.length }
}

/** Extract a files.tar.gz over targetDir (never deletes existing files). */
export function extractFilesArchive(archivePath: string, targetDir: string): { count: number } {
  const tar = Buffer.from(Bun.gunzipSync(fs.readFileSync(archivePath)))
  let off = 0
  let count = 0
  let curName = ''
  let curSize = 0
  let curType = '0'
  const pending: Array<{ name: string; content: Buffer; type: string }> = []
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    curName = Buffer.from(header.subarray(0, 100)).toString('utf8').replace(/\0.*$/, '')
    const prefix = Buffer.from(header.subarray(345, 500)).toString('utf8').replace(/\0.*$/, '')
    const fullName = prefix ? `${prefix}/${curName}` : curName
    curSize = parseInt(Buffer.from(header.subarray(124, 136)).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8)
    curType = String.fromCharCode(header[156] === 0 ? '0'.charCodeAt(0) : header[156])
    const content = tar.subarray(off + 512, off + 512 + curSize)
    pending.push({ name: fullName, content: Buffer.from(content), type: curType })
    off += 512 + curSize
    const pad = (512 - (curSize % 512)) % 512
    off += pad
  }
  for (const item of pending) {
    // path-traversal guard
    const dest = path.resolve(targetDir, item.name)
    if (!dest.startsWith(path.resolve(targetDir) + path.sep) && dest !== path.resolve(targetDir)) continue
    if (item.type === '5') {
      fs.mkdirSync(dest, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, item.content)
    count++
  }
  return { count }
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

function newId(prefix = 'bk'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export interface CreateBackupOptions {
  label?: string
  type?: BackupType
  includeFiles?: boolean
}

export async function createBackup(opts: CreateBackupOptions = {}): Promise<BackupEntry> {
  const started = Date.now()
  const id = newId()
  const dir = path.join(BACKUP_DIR, id)
  fs.mkdirSync(dir, { recursive: true })

  const tables = await listPublicTables()
  if (tables.length === 0) {
    throw new Error('No public tables found — refusing to create an empty backup')
  }
  const insertOrder = await topoInsertOrder(tables.map((t) => t.name))
  const pgVersion = await db.$queryRawUnsafe<Array<{ v: string }>>('SELECT version() AS v')

  const tableData: Record<string, unknown[]> = {}
  const tableMeta: TableMeta[] = []
  let rowCount = 0
  for (const t of tables) {
    // A partial snapshot is DANGEROUS (restoring it would wipe uncaptured
    // tables) — any read failure aborts the whole backup instead of skipping.
    const columns = await getColumns(t.name)
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM "${t.name}"`,
    )
    tableData[t.name] = rows
    rowCount += rows.length
    tableMeta.push({ name: t.name, rows: rows.length, columns })
  }

  const payload = {
    format: 'blasti-backup/1',
    id,
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    pgVersion: pgVersion[0]?.v ?? 'unknown',
    tableCount: tables.length,
    rowCount,
    tables: tableData,
  }
  const json = JSON.stringify(payload, jsonReplacer)
  const gz = Bun.gzipSync(Buffer.from(json, 'utf8'))
  const dataFile = path.join(dir, DATA_FILE)
  fs.writeFileSync(dataFile, gz)

  let filesBytes = 0
  let filesCount = 0
  let includeFiles = opts.includeFiles ?? false
  let filesFile: string | null = null
  if (includeFiles) {
    try {
      const res = createFilesArchive(STORAGE_ROOT, path.join(dir, FILES_FILE))
      filesBytes = res.bytes
      filesCount = res.count
      filesFile = path.join(dir, FILES_FILE)
    } catch (err) {
      // files archive is best-effort — the DB snapshot stays valid
      console.error('[backup] files archive failed:', err)
      includeFiles = false
    }
  }

  const crypto = require('node:crypto') as typeof import('node:crypto')
  const manifest: BackupManifest = {
    id,
    label: opts.label || (opts.type === 'auto' ? 'Auto backup' : 'Manual backup'),
    type: opts.type ?? 'manual',
    createdAt: new Date().toISOString(),
    includeFiles,
    appVersion: APP_VERSION,
    pgVersion: pgVersion[0]?.v ?? 'unknown',
    dbSizeBytes: tables.reduce((a, t) => a + t.sizeBytes, 0),
    tables: tableMeta,
    insertOrder,
    rowCount,
    dataBytes: gz.length,
    filesBytes,
    filesCount,
    dataSha256: crypto.createHash('sha256').update(gz).digest('hex'),
    durationMs: Date.now() - started,
  }
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2))

  const entry: BackupEntry = {
    ...manifest,
    dataFile,
    filesFile,
  }
  const s = loadState()
  s.backups.unshift(entry)
  saveState()
  return entry
}

// ─── Restore ────────────────────────────────────────────────────────────────

/** Cast suffix per PostgreSQL data_type so text-encoded JSON values restore losslessly. */
function castFor(column: { dataType: string; udtName?: string }): string {
  if (column.dataType === 'USER-DEFINED') {
    // native enum (Prisma enum model) — text param needs an explicit cast
    return column.udtName ? `::"${column.udtName}"` : '::text'
  }
  switch (column.dataType) {
    case 'json':
    case 'jsonb':
      return '::jsonb'
    case 'uuid':
      return '::uuid'
    case 'timestamp without time zone':
      return '::timestamp'
    case 'timestamp with time zone':
      return '::timestamptz'
    case 'date':
      return '::date'
    case 'time without time zone':
      return '::time'
    case 'numeric':
      return '::numeric'
    case 'boolean':
      return '::boolean'
    case 'bytea':
      return '::bytea'
    case 'integer':
    case 'smallint':
      return '::integer'
    case 'bigint':
      return '::bigint'
    case 'real':
      return '::real'
    case 'double precision':
      return '::double precision'
    default:
      return ''
  }
}

function paramValue(
  column: { dataType: string; udtName?: string },
  value: unknown,
): unknown {
  if (value === null || value === undefined) return null
  const dataType = column.dataType
  switch (dataType) {
    case 'boolean':
      return value === true || value === 'true' ? 'true' : 'false'
    case 'json':
    case 'jsonb':
      return typeof value === 'string' ? value : JSON.stringify(value, jsonReplacer)
    case 'bytea':
      if (value && typeof value === 'object' && '$b64' in (value as Record<string, unknown>)) {
        return Buffer.from((value as { $b64: string }).$b64, 'base64')
      }
      return value
    default: {
      const ctor = (value as { constructor?: { name?: string } })?.constructor?.name
      if (typeof value === 'object' && (ctor === 'Decimal' || typeof value === 'bigint')) {
        return String(value)
      }
      if (typeof value === 'object' && !(value instanceof Date) && dataType !== 'json' && dataType !== 'jsonb') {
        return JSON.stringify(value, jsonReplacer)
      }
      return value
    }
  }
}

export async function insertRows(
  tx: { $executeRawUnsafe: (q: string, ...p: unknown[]) => Promise<number> },
  table: TableMeta,
  rows: unknown[],
): Promise<number> {
  if (rows.length === 0) return 0
  const casts = table.columns.map((c) => castFor(c))
  const colDefs = table.columns.map((c) => `"${c.name}"`)
  const CHUNK = 200
  let inserted = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const valuesClauses: string[] = []
    const params: unknown[] = []
    let p = 0
    for (const row of chunk as Array<Record<string, unknown>>) {
      const placeholders = table.columns.map((c, ci) => {
        p++
        params.push(paramValue(c, row[c.name] ?? null))
        return `$${p}${casts[ci]}`
      })
      valuesClauses.push(`(${placeholders.join(', ')})`)
    }
    const sql = `INSERT INTO "${table.name}" (${colDefs.join(', ')}) VALUES ${valuesClauses.join(', ')}`
    await tx.$executeRawUnsafe(sql, ...params)
    inserted += chunk.length
  }
  return inserted
}

// ─── FK-aware full-table copy (restore + external migrate) ─────────────────

interface RawTxClient {
  $queryRawUnsafe: (sql: string) => Promise<Array<Record<string, unknown>>>
  $executeRawUnsafe: (sql: string, ...p: unknown[]) => Promise<number>
}

interface FkConstraint {
  /** constraint name, e.g. PlanFeature_planId_fkey */
  name: string
  /** owning table — regclass output, already properly quoted */
  tbl: string
  /** full definition from pg_get_constraintdef (FOREIGN KEY … REFERENCES …) */
  def: string
}

function stripRegclass(s: string): string {
  return s
    .replace(/^"public"\./, '')
    .replace(/^public\./, '')
    .replace(/^"/, '')
    .replace(/"$/, '')
}

async function listFkConstraints(tx: RawTxClient): Promise<FkConstraint[]> {
  const rows = await tx.$queryRawUnsafe(
    `SELECT con.conname, con.conrelid::regclass::text AS tbl, pg_get_constraintdef(con.oid) AS def
     FROM pg_constraint con
     JOIN pg_namespace n ON n.oid = con.connamespace
     WHERE con.contype = 'f' AND n.nspname = 'public'`,
  )
  return rows.map((r) => ({
    name: r.conname as string,
    tbl: r.tbl as string,
    def: r.def as string,
  }))
}

/**
 * Copy ALL tables into a target database inside one transaction:
 *   1. drop every public FK constraint (the schema has FK cycles —
 *      Agency.planId ↔ SubscriptionPlan.agencyId — so insert order alone
 *      can never satisfy them)
 *   2. TRUNCATE the target tables
 *   3. insert rows (topological order kept for readability)
 *   4. re-add every FK constraint — validating the COMPLETE dataset
 * Any failure rolls the whole transaction back (target keeps its prior data).
 */
export async function copyAllTablesInTx(
  tx: RawTxClient,
  order: string[],
  metaByName: Map<string, TableMeta>,
  payloadTables: Record<string, unknown[]>,
): Promise<void> {
  // only touch constraints whose owning table participates in the copy
  const tableSet = new Set(order)
  const fks = (await listFkConstraints(tx)).filter((fk) => tableSet.has(stripRegclass(fk.tbl)))

  let dropped = 0
  for (const fk of fks) {
    await tx.$executeRawUnsafe(`ALTER TABLE ${fk.tbl} DROP CONSTRAINT "${fk.name}"`)
    dropped++
  }
  console.log(`[copy] dropped ${dropped} FK constraints`)

  const allNames = order.map((t) => `"${t}"`)
  await tx.$executeRawUnsafe(`TRUNCATE TABLE ${allNames.join(', ')} CASCADE`)

  let done = 0
  for (const name of order) {
    const meta = metaByName.get(name)!
    await insertRows(tx as never, meta, payloadTables[name] ?? [])
    done++
    if (done % 10 === 0) {
      console.log(`[copy] ${done}/${order.length} tables (${name})`)
    }
  }

  let reAdded = 0
  for (const fk of fks) {
    await tx.$executeRawUnsafe(`ALTER TABLE ${fk.tbl} ADD CONSTRAINT "${fk.name}" ${fk.def}`)
    reAdded++
  }
  console.log(`[copy] re-added ${reAdded} FK constraints`)
}

export async function realignSequences(): Promise<number> {
  const seqs = await db.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_default LIKE 'nextval%'`,
  )
  let n = 0
  for (const s of seqs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.table_name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.column_name)) continue
    await db.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${s.table_name}"', '${s.column_name}'),
        GREATEST((SELECT COALESCE(MAX("${s.column_name}"), 0) FROM "${s.table_name}"), 1))`,
    )
    n++
  }
  return n
}

export interface RestoreResult {
  restoredTables: number
  restoredRows: number
  sequencesRealigned: number
  verification: Array<{ table: string; expected: number; actual: number; ok: boolean }>
  filesRestored: number
  durationMs: number
  safetyBackupId: string
}

export async function restoreBackup(
  backupId: string,
  opts: { restoreFiles?: boolean } = {},
): Promise<RestoreResult> {
  const started = Date.now()
  const s = loadState()
  const entry = s.backups.find((b) => b.id === backupId)
  if (!entry) throw new Error(`Backup ${backupId} not found`)
  if (!fs.existsSync(entry.dataFile)) {
    throw new Error(`Backup data file missing on disk: ${entry.dataFile}`)
  }

  // 1. safety snapshot FIRST (survives even a botched restore)
  const safety = await createBackup({
    label: `Safety snapshot before restore of ${entry.label}`,
    type: 'pre-restore',
  })

  // 2. read payload
  const gz = fs.readFileSync(entry.dataFile)
  const crypto = require('node:crypto') as typeof import('node:crypto')
  const sha = crypto.createHash('sha256').update(gz).digest('hex')
  if (sha !== entry.dataSha256) {
    throw new Error(`Checksum mismatch: expected ${entry.dataSha256}, got ${sha}`)
  }
  const payload = JSON.parse(Buffer.from(Bun.gunzipSync(gz)).toString("utf8")) as {
    tables: Record<string, unknown[]>
  }

  // 3. atomic restore: TRUNCATE + inserts in ONE transaction (rollback-safe).
  // FK constraints are dropped INSIDE the tx and re-added at the end — the
  // schema contains genuine FK cycles (Agency.planId ↔ SubscriptionPlan.
  // agencyId), so no topological order can satisfy every constraint; re-adding
  // the constraints after all inserts validates the complete dataset instead.
  const metaByName = new Map(entry.tables.map((t) => [t.name, t]))
  const order = entry.insertOrder.filter((t) => metaByName.has(t))

  await db.$transaction(
    async (tx) => {
      await copyAllTablesInTx(tx as never, order, metaByName, payload.tables)
    },
    { timeout: 30 * 60 * 1000, maxWait: 30_000 },
  )

  // 4. realign sequences (outside the tx — setval is session-safe)
  const sequencesRealigned = await realignSequences()

  // 5. verify counts
  const verification: RestoreResult['verification'] = []
  for (const t of entry.tables) {
    let actual = -1
    try {
      const rows = await db.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT COUNT(*)::bigint AS c FROM "${t.name}"`,
      )
      actual = Number(rows[0]?.c ?? 0)
    } catch {
      actual = -1
    }
    verification.push({ table: t.name, expected: t.rows, actual, ok: actual === t.rows })
  }

  // 6. optional files restore
  let filesRestored = 0
  if (opts.restoreFiles && entry.filesFile && fs.existsSync(entry.filesFile)) {
    filesRestored = extractFilesArchive(entry.filesFile, STORAGE_ROOT).count
  }

  const result: RestoreResult = {
    restoredTables: order.length,
    restoredRows: verification.reduce((a, v) => a + Math.max(v.actual, 0), 0),
    sequencesRealigned,
    verification,
    filesRestored,
    durationMs: Date.now() - started,
    safetyBackupId: safety.id,
  }
  const mismatched = verification.filter((v) => !v.ok)
  if (mismatched.length > 0) {
    console.error('[restore] VERIFICATION MISMATCH:', mismatched)
  }
  return result
}

// ─── Retention ──────────────────────────────────────────────────────────────

export function deleteBackup(backupId: string): { deleted: boolean } {
  const s = loadState()
  const entry = s.backups.find((b) => b.id === backupId)
  if (!entry) return { deleted: false }
  try {
    fs.rmSync(path.join(BACKUP_DIR, backupId), { recursive: true, force: true })
  } catch (err) {
    console.error('[backup] delete files failed:', err)
  }
  s.backups = s.backups.filter((b) => b.id !== backupId)
  saveState()
  return { deleted: true }
}

export function applyRetention(): number {
  const s = loadState()
  const auto = s.backups.filter((b) => b.type === 'auto')
  if (auto.length <= s.settings.keepLastN) return 0
  const toDelete = auto
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, auto.length - s.settings.keepLastN)
  for (const b of toDelete) deleteBackup(b.id)
  return toDelete.length
}

// ─── Settings ───────────────────────────────────────────────────────────────

export function updateSettings(patch: Partial<BackupSettings>): BackupSettings {
  const s = loadState()
  s.settings = { ...s.settings, ...patch }
  if (s.settings.keepLastN < 1) s.settings.keepLastN = 1
  if (s.settings.dailyAt && !/^\d{2}:\d{2}$/.test(s.settings.dailyAt)) {
    s.settings.dailyAt = null
  }
  // ALWAYS recompute the schedule when enabled — a stale nextRunAt from a
  // previous configuration would fire the wrong cadence (or never)
  s.nextRunAt = s.settings.enabled ? computeNextRun(s.settings).toISOString() : null
  saveState()
  return s.settings
}

/** Next run in Africa/Algiers wall-clock terms (interval or daily-at). */
export function computeNextRun(settings: BackupSettings, from: Date = new Date()): Date {
  if (settings.dailyAt) {
    const [hh, mm] = settings.dailyAt.split(':').map(Number)
    // Algiers = UTC+1 (no DST) — compute wall clock directly
    const algiersNow = new Date(from.getTime() + 60 * 60 * 1000)
    const candidate = new Date(algiersNow)
    candidate.setUTCHours(hh, mm, 0, 0)
    if (candidate.getTime() <= algiersNow.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() + 1)
    }
    return new Date(candidate.getTime() - 60 * 60 * 1000)
  }
  const hours = settings.intervalHours && settings.intervalHours > 0 ? settings.intervalHours : 24
  return new Date(from.getTime() + hours * 60 * 60 * 1000)
}

export function scheduleNextRun(from: Date = new Date()): string {
  const s = loadState()
  s.nextRunAt = computeNextRun(s.settings, from).toISOString()
  saveState()
  return s.nextRunAt
}

export function getDueForAutoBackup(now: Date = new Date()): boolean {
  const s = loadState()
  if (!s.settings.enabled || !s.nextRunAt) return false
  return new Date(s.nextRunAt).getTime() <= now.getTime()
}

// ─── Long job runner (mutex + status) ───────────────────────────────────────

export async function runBackupJob(opts: CreateBackupOptions & { auto?: boolean } = {}): Promise<BackupEntry> {
  if (isBusy()) throw new Error('Another backup/restore job is already running')
  busy = true
  setRunningJob({
    kind: 'backup',
    label: opts.label || 'Creating backup…',
    startedAt: new Date().toISOString(),
  })
  try {
    const entry = await createBackup(opts)
    const s = loadState()
    s.runningJob = null
    saveState()
    return entry
  } catch (err) {
    setRunningJob(null)
    throw err
  } finally {
    busy = false
  }
}

export async function runRestoreJob(backupId: string, opts: { restoreFiles?: boolean } = {}): Promise<RestoreResult> {
  if (isBusy()) throw new Error('Another backup/restore job is already running')
  busy = true
  setRunningJob({
    kind: 'restore',
    label: `Restoring ${backupId}…`,
    startedAt: new Date().toISOString(),
    backupId,
  })
  try {
    const result = await restoreBackup(backupId, opts)
    setRunningJob(null)
    return result
  } catch (err) {
    setRunningJob(null)
    throw err
  } finally {
    busy = false
  }
}

export async function runPushJob(job: { label: string; backupId?: string; targetName?: string; fn: () => Promise<unknown> }): Promise<unknown> {
  if (isBusy()) throw new Error('Another backup/restore job is already running')
  busy = true
  setRunningJob({
    kind: 'push',
    label: job.label,
    startedAt: new Date().toISOString(),
    backupId: job.backupId,
    targetName: job.targetName,
  })
  try {
    const result = await job.fn()
    setRunningJob(null)
    return result
  } catch (err) {
    setRunningJob(null)
    throw err
  } finally {
    busy = false
  }
}
