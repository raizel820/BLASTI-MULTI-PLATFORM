/**
 * @blasti/api — Backup Targets
 *
 * Pluggable external destinations for backups ("migrate to external
 * services for backup"):
 *
 *   s3           ANY S3-compatible endpoint via AWS SigV4 (no SDK):
 *                Cloudflare R2, AWS S3, Backblaze B2, Minio, Scaleway,
 *                DO Spaces, Wasabi …
 *   azure-blob   Azure Blob Storage via SharedKey (account key) or SAS token
 *   d1           Cloudflare D1 — generates a SQLite-dialect dump from the
 *                snapshot and imports it through the D1 HTTP import API
 *   postgres     ANY PostgreSQL connection string (Neon, Supabase, RDS,
 *                Docker, …) — pushes the Prisma schema (prisma db push) and
 *                copies ALL data table-by-table in FK order, realigns
 *                sequences and verifies counts — a full live migration.
 *
 * Secrets are stored in the backup state file and ALWAYS masked in API
 * responses (maskSecrets).
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { db, Prisma, PrismaClient } from '@blasti/db'
import {
  BACKUP_DIR,
  REPO_ROOT,
  type BackupEntry,
  type TableMeta,
  type TargetConfig,
  copyAllTablesInTx,
  topoInsertOrder,
} from './backup-engine'

const DATA_FILE = 'data.json.gz'
const FILES_FILE = 'files.tar.gz'

// ─── Secrets masking ────────────────────────────────────────────────────────

const SECRET_FIELDS = new Set([
  'secretAccessKey',
  'accountKey',
  'sasToken',
  'apiToken',
  'url',
])

export function maskSecrets<T extends Record<string, unknown>>(target: T): T {
  const out: Record<string, unknown> = { ...target }
  for (const key of Object.keys(out)) {
    if (SECRET_FIELDS.has(key) && typeof out[key] === 'string' && out[key]) {
      const v = out[key] as string
      if (key === 'url') {
        // postgres URLs: postgres://user:pass@host/db → keep user/host, mask pass
        out[key] = v.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:••••@')
      } else {
        out[key] = v.length <= 4 ? '••••' : '••••' + v.slice(-4)
      }
    }
  }
  return out as T
}

// ─── Validation ─────────────────────────────────────────────────────────────

export function validateTargetInput(t: Partial<TargetConfig>): { ok: true } | { ok: false; error: string } {
  switch (t.type) {
    case 's3':
      if (!t.endpoint || !t.bucket || !t.accessKeyId || !t.secretAccessKey) {
        return { ok: false, error: 's3 requires endpoint, bucket, accessKeyId, secretAccessKey' }
      }
      return { ok: true }
    case 'azure-blob':
      if (!t.account || !t.container || (!t.accountKey && !t.sasToken)) {
        return { ok: false, error: 'azure-blob requires account, container and (accountKey | sasToken)' }
      }
      return { ok: true }
    case 'd1':
      if (!t.accountId || !t.databaseId || !t.apiToken) {
        return { ok: false, error: 'd1 requires accountId, databaseId, apiToken' }
      }
      return { ok: true }
    case 'postgres':
      if (!t.url || !/^postgres(ql)?:\/\//.test(t.url)) {
        return { ok: false, error: 'postgres requires a postgres:// or postgresql:// connection string' }
      }
      return { ok: true }
    default:
      return { ok: false, error: 'Unknown target type' }
  }
}

// ─── S3-compatible (SigV4, no SDK) ──────────────────────────────────────────

function hmac(key: crypto.BinaryLike | crypto.KeyObject, data: string): crypto.Binary {
  return crypto.createHmac('sha256', key).update(data).digest()
}

function sha256hex(data: crypto.Binary | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

export async function pushToS3(target: TargetConfig, file: { name: string; path: string }): Promise<{ key: string }> {
  const endpoint = target.endpoint!.replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error(`Invalid endpoint URL: ${target.endpoint}`)
  }
  const region = target.region || 'auto'
  const prefix = (target.prefix || '').replace(/^\/+|\/+$/g, '')
  const key = prefix ? `${prefix}/${file.name}` : file.name
  const host = target.endpoint!.includes('amazonaws.com')
    ? `${target.bucket}.s3.amazonaws.com`
    : url.host // path-style (R2, Minio, B2, Spaces…)
  const pathStyle = !target.endpoint!.includes('amazonaws.com')
  const canonicalUri = pathStyle
    ? `/${target.bucket}/${encodeURI(key).replace(/,/g, '%2C')}`
    : `/${encodeURI(key).replace(/,/g, '%2C')}`

  const body = fs.readFileSync(file.path)
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256hex(body)

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n')

  const kDate = hmac(`AWS4${target.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const authorization = `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const res = await fetch(`${url.origin}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'content-length': String(body.length),
    },
    body: new Uint8Array(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`S3 upload failed (${res.status}): ${text.slice(0, 300)}`)
  }
  return { key }
}

// ─── Azure Blob Storage ─────────────────────────────────────────────────────

export async function pushToAzureBlob(
  target: TargetConfig,
  file: { name: string; path: string },
): Promise<{ key: string }> {
  const prefix = (target.prefix || '').replace(/^\/+|\/+$/g, '')
  const blobPath = prefix ? `${prefix}/${file.name}` : file.name
  const encoded = encodeURI(blobPath).replace(/,/g, '%2C')
  const url = `https://${target.account}.blob.core.windows.net/${target.container}/${encoded}`
  const body = fs.readFileSync(file.path)

  const headers: Record<string, string> = {
    'x-ms-blob-type': 'BlockBlob',
    'content-length': String(body.length),
  }

  if (target.sasToken) {
    const sas = target.sasToken.startsWith('?') ? target.sasToken : `?${target.sasToken}`
    const res = await fetch(url + sas, {
      method: 'PUT',
      headers,
      body: new Uint8Array(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Azure upload failed (${res.status}): ${text.slice(0, 300)}`)
    }
    return { key: blobPath }
  }

  // SharedKey signing
  const now = new Date()
  const date = now.toUTCString()
  headers['x-ms-date'] = date
  headers['x-ms-version'] = '2021-08-06'
  const canonicalHeaders =
    `x-ms-blob-type:BlockBlob\nx-ms-date:${date}\nx-ms-version:2021-08-06\n`
  const canonicalResource = `/${target.account}/${target.container}/${blobPath}`
  const stringToSign = [
    'PUT',
    '', // content-encoding
    '', // content-language
    String(body.length),
    '', // content-md5
    '', // content-type
    '', // date (x-ms-date used)
    '', // if-modified-since
    '', // if-match
    '', // if-none-match
    '', // if-unmodified-since
    '', // range
    canonicalHeaders,
    canonicalResource,
  ].join('\n')
  const signature = crypto
    .createHmac('sha256', Buffer.from(target.accountKey!, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64')
  headers['Authorization'] = `SharedKey ${target.account}:${signature}`

  const res = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(body) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Azure upload failed (${res.status}): ${text.slice(0, 300)}`)
  }
  return { key: blobPath }
}

// ─── Cloudflare D1 (SQLite-dialect dump + HTTP import) ─────────────────────

function sqliteType(pgType: string): string {
  switch (pgType) {
    case 'integer':
    case 'smallint':
    case 'bigint':
    case 'boolean':
      return 'INTEGER'
    case 'real':
    case 'double precision':
    case 'numeric':
      return 'REAL'
    case 'bytea':
      return 'BLOB'
    default:
      return 'TEXT' // text, uuid, json/jsonb, timestamps, dates, everything else
  }
}

function sqlEscape(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'bigint') return `'${v.toString()}'`
  const ctor = (v as { constructor?: { name?: string } })?.constructor?.name
  if (ctor === 'Decimal') return `'${String(v)}'`
  if (v instanceof Date) return `'${v.toISOString()}'`
  if (typeof v === 'object') {
    if ('$b64' in (v as Record<string, unknown>)) {
      return `X'${Buffer.from((v as { $b64: string }).$b64, 'base64').toString('hex')}'`
    }
    return `'${JSON.stringify(v).replace(/'/g, "''")}'`
  }
  return `'${String(v).replace(/'/g, "''")}'`
}

/** Convert a backup snapshot into a single SQLite-dialect SQL dump. */
export function snapshotToSqliteDump(entry: BackupEntry): string {
  const gz = fs.readFileSync(entry.dataFile)
  const payload = JSON.parse(Buffer.from(Bun.gunzipSync(gz)).toString("utf8")) as {
    tables: Record<string, unknown[]>
  }
  const out: string[] = [
    '-- BLASTI backup → Cloudflare D1 (SQLite dialect)',
    `-- generated ${new Date().toISOString()} from backup ${entry.id}`,
    'PRAGMA foreign_keys=OFF;',
    'BEGIN TRANSACTION;',
  ]
  for (const table of entry.tables) {
    const cols = table.columns
      .map((c) => `"${c.name}" ${sqliteType(c.dataType)}`)
      .join(', ')
    out.push(`CREATE TABLE IF NOT EXISTS "${table.name}" (${cols});`)
    const rows = payload.tables[table.name] ?? []
    const colNames = table.columns.map((c) => `"${c.name}"`).join(', ')
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50) as Array<Record<string, unknown>>
      const values = chunk
        .map(
          (r) =>
            `(${table.columns.map((c) => sqlEscape(r[c.name] ?? null)).join(', ')})`,
        )
        .join(',\n')
      if (values.length > 0) {
        out.push(`INSERT INTO "${table.name}" (${colNames}) VALUES\n${values};`)
      }
    }
  }
  out.push('COMMIT;')
  return out.join('\n')
}

export async function pushToD1(
  target: TargetConfig,
  entry: BackupEntry,
): Promise<{ rowsImported: number }> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}/import`
  const dump = snapshotToSqliteDump(entry)
  const filename = `blasti-${entry.id}.sql`

  // step 1: init → upload_url + upload_token
  const initRes = await fetch(base, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'init', filename }),
  })
  const initJson = (await initRes.json()) as {
    success: boolean
    errors?: Array<{ message: string }>
    result?: { upload_url: string; upload_token: string }
  }
  if (!initRes.ok || !initJson.success || !initJson.result) {
    throw new Error(
      `D1 import init failed: ${initJson.errors?.[0]?.message || initRes.status}`,
    )
  }

  // step 2: PUT the dump
  const putRes = await fetch(initJson.result.upload_url, {
    method: 'PUT',
    body: Buffer.from(dump, 'utf8'),
    headers: { 'Content-Type': 'application/sql' },
  })
  const etag = putRes.headers.get('etag') || ''
  if (!putRes.ok) {
    throw new Error(`D1 dump upload failed (${putRes.status})`)
  }

  // step 3: confirm
  const confirmRes = await fetch(base, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'confirm',
      etag,
      upload_token: initJson.result.upload_token,
    }),
  })
  const confirmJson = (await confirmRes.json()) as {
    success: boolean
    errors?: Array<{ message: string }>
    result?: { num_inserted_rows?: number; num_table_queries?: number }
  }
  if (!confirmRes.ok || !confirmJson.success) {
    throw new Error(
      `D1 import confirm failed: ${confirmJson.errors?.[0]?.message || confirmRes.status}`,
    )
  }
  return { rowsImported: confirmJson.result?.num_inserted_rows ?? 0 }
}

// ─── External PostgreSQL (Neon / Supabase / RDS / …) ───────────────────────

export interface ExternalPgResult {
  schema: 'pushed'
  restoredTables: number
  restoredRows: number
  sequencesRealigned: number
  verification: Array<{ table: string; expected: number; actual: number; ok: boolean }>
  durationMs: number
}

/**
 * FULL live migration into an external PostgreSQL: push the Prisma schema
 * (prisma db push against the target URL), TRUNCATE the target, copy every
 * table in FK order inside one transaction, realign sequences, verify.
 */
export async function migrateToExternalPostgres(url: string): Promise<ExternalPgResult> {
  const started = Date.now()

  // 1. schema push against the target (spawn prisma with overridden env)
  const { spawnSync } = await import('node:child_process')
  const res = spawnSync('bun', ['packages/db/scripts/db-cli.mjs', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  })
  if (res.status !== 0) {
    throw new Error(
      `Schema push to external Postgres failed: ${(res.stderr || res.stdout || '').slice(-800)}`,
    )
  }

  // 2. target client
  const targetDb = new PrismaClient({
    datasources: { db: { url } },
  })

  try {
    // 3. enumerate local tables + order
    const localTables = await db.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name != '_prisma_migrations'
       ORDER BY table_name`,
    )
    const names = localTables.map((t) => t.table_name)
    const order = await topoInsertOrder(names)

    const metaByName = new Map<string, TableMeta>()
    const tablesPayload: Record<string, unknown[]> = {}
    for (const name of order) {
      const cols = (await db.$queryRawUnsafe<Array<{ column_name: string; data_type: string; udt_name: string }>>(
        `SELECT column_name, data_type, udt_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
        name,
      )).map((c) => ({
        name: c.column_name,
        dataType: c.data_type,
        udtName: c.data_type === 'USER-DEFINED' ? c.udt_name : undefined,
      }))
      const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM "${name}"`,
      )
      tablesPayload[name] = rows
      metaByName.set(name, { name, columns: cols, rows: rows.length })
    }

    // 4. copy (target tx: drop FKs → TRUNCATE → insert → re-add FKs — atomic
    // on the target too; same FK-cycle-safe helper the local restore uses)
    await targetDb.$transaction(
      async (tx) => {
        await copyAllTablesInTx(tx as never, order, metaByName, tablesPayload)
      },
      { timeout: 30 * 60 * 1000, maxWait: 30_000 },
    )

    // 5. realign sequences ON THE TARGET (raw queries against the external client)
    let sequencesRealigned = 0
    const seqs = await targetDb.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='public' AND column_default LIKE 'nextval%'`,
    )
    for (const s of seqs) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.table_name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.column_name)) continue
      await targetDb.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"${s.table_name}"', '${s.column_name}'),
          GREATEST((SELECT COALESCE(MAX("${s.column_name}"), 0) FROM "${s.table_name}"), 1))`,
      )
      sequencesRealigned++
    }

    // 6. verify
    const verification: ExternalPgResult['verification'] = []
    for (const t of metaByName.values()) {
      const rows = await targetDb.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT COUNT(*)::bigint AS c FROM "${t.name}"`,
      )
      const actual = Number(rows[0]?.c ?? 0)
      verification.push({ table: t.name, expected: t.rows, actual, ok: actual === t.rows })
    }

    return {
      schema: 'pushed',
      restoredTables: order.length,
      restoredRows: verification.reduce((a, v) => a + v.actual, 0),
      sequencesRealigned,
      verification,
      durationMs: Date.now() - started,
    }
  } finally {
    await targetDb.$disconnect().catch(() => {})
  }
}

/** Lightweight connectivity + permission probe for a postgres URL. */
export async function testExternalPostgres(url: string): Promise<{ version: string; canCreate: boolean }> {
  const targetDb = new PrismaClient({ datasources: { db: { url } } })
  const probeTable = `__blasti_probe_${Date.now().toString(36)}`
  try {
    const v = await targetDb.$queryRawUnsafe<Array<{ v: string }>>('SELECT version() AS v')
    let canCreate = false
    try {
      await targetDb.$executeRawUnsafe(`CREATE TABLE "${probeTable}" (id integer)`)
      canCreate = true
    } catch {
      canCreate = false
    }
    try {
      await targetDb.$executeRawUnsafe(`DROP TABLE IF EXISTS "${probeTable}"`)
    } catch {
      // best effort
    }
    return { version: v[0]?.v ?? 'unknown', canCreate }
  } finally {
    await targetDb.$disconnect().catch(() => {})
  }
}

// ─── Connectivity probes ────────────────────────────────────────────────────

const PROBE_BODY = Buffer.from('blasti-probe')

/** PUT + DELETE a tiny probe object — proves endpoint + bucket + credentials. */
export async function testS3Target(target: TargetConfig): Promise<void> {
  const probe: { name: string; path: string } = {
    name: '.blasti-probe.txt',
    path: path.join(BACKUP_DIR, '.probe.txt'),
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  fs.writeFileSync(probe.path, PROBE_BODY)
  await pushToS3(target, probe)
  // best-effort DELETE via signed request
  try {
    await sigV4Request(target, 'DELETE', probe.name)
  } catch {
    // cleanup failure is not a test failure
  }
}

/** PUT + DELETE a tiny probe blob (SharedKey or SAS). */
export async function testAzureTarget(target: TargetConfig): Promise<void> {
  const probe: { name: string; path: string } = {
    name: '.blasti-probe.txt',
    path: path.join(BACKUP_DIR, '.probe.txt'),
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  fs.writeFileSync(probe.path, PROBE_BODY)
  await pushToAzureBlob(target, probe)
  try {
    const prefix = (target.prefix || '').replace(/^\/+|\/+$/g, '')
    const blobPath = prefix ? `${prefix}/${probe.name}` : probe.name
    const url = `https://${target.account}.blob.core.windows.net/${target.container}/${encodeURI(blobPath)}`
    if (target.sasToken) {
      const sas = target.sasToken.startsWith('?') ? target.sasToken : `?${target.sasToken}`
      await fetch(url + sas, { method: 'DELETE' })
    } else {
      const now = new Date()
      const date = now.toUTCString()
      const canonicalHeaders = `x-ms-date:${date}\nx-ms-version:2021-08-06\n`
      const canonicalResource = `/${target.account}/${target.container}/${blobPath}`
      const stringToSign = [
        'DELETE', '', '', '', '', '', '', '', '', '', '',
        canonicalHeaders,
        canonicalResource,
      ].join('\n')
      const signature = crypto
        .createHmac('sha256', Buffer.from(target.accountKey!, 'base64'))
        .update(stringToSign, 'utf8')
        .digest('base64')
      await fetch(url, {
        method: 'DELETE',
        headers: {
          'x-ms-date': date,
          'x-ms-version': '2021-08-06',
          Authorization: `SharedKey ${target.account}:${signature}`,
        },
      })
    }
  } catch {
    // cleanup failure is not a test failure
  }
}

/** Generic SigV4 request (used for probe cleanup + future verbs). */
async function sigV4Request(
  target: TargetConfig,
  method: 'PUT' | 'DELETE' | 'GET',
  key: string,
): Promise<Response> {
  const endpoint = target.endpoint!.replace(/\/+$/, '')
  const url = new URL(endpoint)
  const region = target.region || 'auto'
  const prefix = (target.prefix || '').replace(/^\/+|\/+$/g, '')
  const objectKey = prefix ? `${prefix}/${key}` : key
  const pathStyle = !target.endpoint!.includes('amazonaws.com')
  const host = pathStyle ? url.host : `${target.bucket}.s3.amazonaws.com`
  const canonicalUri = pathStyle
    ? `/${target.bucket}/${encodeURI(objectKey)}`
    : `/${encodeURI(objectKey)}`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256hex('')
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n')
  const kDate = hmac(`AWS4${target.secretAccessKey}`, dateStamp)
  const kSigning = hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return fetch(`${url.origin}${canonicalUri}`, {
    method,
    headers: {
      Authorization: authorization,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    },
  })
}

// ─── Unified push ───────────────────────────────────────────────────────────

export interface PushResult {
  provider: TargetConfig['type']
  uploaded: Array<{ name: string; bytes?: number; key?: string }>
  migrated?: ExternalPgResult
  d1?: { rowsImported: number }
}

export async function pushBackupToTarget(target: TargetConfig, entry: BackupEntry): Promise<PushResult> {
  const uploaded: PushResult['uploaded'] = []

  switch (target.type) {
    case 's3': {
      const stamp = entry.id
      const r1 = await pushToS3(target, { name: `${stamp}-${DATA_FILE}`, path: entry.dataFile })
      uploaded.push({ name: DATA_FILE, bytes: entry.dataBytes, key: r1.key })
      if (entry.filesFile && fs.existsSync(entry.filesFile)) {
        const r2 = await pushToS3(target, { name: `${stamp}-${FILES_FILE}`, path: entry.filesFile })
        uploaded.push({ name: FILES_FILE, bytes: entry.filesBytes, key: r2.key })
      }
      return { provider: 's3', uploaded }
    }
    case 'azure-blob': {
      const stamp = entry.id
      const r1 = await pushToAzureBlob(target, { name: `${stamp}-${DATA_FILE}`, path: entry.dataFile })
      uploaded.push({ name: DATA_FILE, bytes: entry.dataBytes, key: r1.key })
      if (entry.filesFile && fs.existsSync(entry.filesFile)) {
        const r2 = await pushToAzureBlob(target, { name: `${stamp}-${FILES_FILE}`, path: entry.filesFile })
        uploaded.push({ name: FILES_FILE, bytes: entry.filesBytes, key: r2.key })
      }
      return { provider: 'azure-blob', uploaded }
    }
    case 'd1': {
      const d1 = await pushToD1(target, entry)
      return { provider: 'd1', uploaded: [{ name: 'sqlite-dump (imported)' }], d1 }
    }
    case 'postgres': {
      const migrated = await migrateToExternalPostgres(target.url!)
      return { provider: 'postgres', uploaded: [], migrated }
    }
    default:
      throw new Error(`Unsupported target type: ${target.type}`)
  }
}

export function resolveEntry(backupId: string | undefined): BackupEntry {
  // imported lazily to avoid a cycle at module init
  const { getState } = require('./backup-engine') as typeof import('./backup-engine')
  const s = getState()
  let entry: BackupEntry | undefined
  if (backupId) {
    entry = s.backups.find((b) => b.id === backupId)
  } else {
    entry = s.backups[0] // newest
  }
  if (!entry) throw new Error('Backup not found — nothing to push')
  if (!fs.existsSync(entry.dataFile)) throw new Error(`Backup data file missing: ${entry.dataFile}`)
  return entry
}
