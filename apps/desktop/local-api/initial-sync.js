/**
 * BLASTI Desktop — Initial Sync Engine (v2)
 *
 * Handles the first-time import of all agency data from the Cloud API
 * into the local SQLite database. This runs when a user logs into the
 * Desktop app for the FIRST TIME on a machine.
 *
 * Architecture:
 *   Cloud API (POST /api/sync/initial-data) → initial-sync.js → Local SQLite (Prisma)
 *
 * Key features:
 *   - Uses NEW Cloud API endpoint: POST /api/sync/initial-data
 *   - AgencyLocalState table for tracking initialization (not _sync_meta)
 *   - Discovery call → get list of stages → process each stage with cursor pagination
 *   - Idempotent upserts: db.model.upsert() for every record (never duplicates)
 *   - Transactional batches: each batch in a Prisma $transaction
 *   - Proper resumability: read AgencyLocalState on resume, continue from currentStage/currentCursor
 *   - State machine: NOT_INITIALIZED → INITIALIZING → READY (or FAILED)
 *   - Never mark READY prematurely: only after ALL mandatory stages + integrity validation
 *   - Snapshot sequence: stored for incremental sync baseline
 *   - Agency isolation: all queries scoped to authenticated agencyId
 *
 * This module is SEPARATE from sync-service.js (incremental sync).
 * Do NOT modify sync-service.js — initial sync is a one-time bulk import.
 */

const { randomUUID } = require('crypto')

// Task 46: schema-aware record sanitizer shared by EVERY sync import path
// (staged import, reconciliation, snapshot bridge — and, via its own wiring,
// the incremental pull in sync-service). Makes the local DB functional when
// some fields are NULL (webapp-registered agency completing setup on
// desktop) by dropping unknown columns / null-on-not-null values instead of
// failing the whole stage.
const { sanitizeSyncRecord, formatDropped, copyFallbackTags, getFallbackKeys } = require('./lib/sync-record-sanitize')

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 500
const MAX_BACKOFF_MS = 30_000
const INITIAL_BACKOFF_MS = 1_000
const MAX_RETRIES_PER_REQUEST = 5
const MAX_5XX_RETRIES_PER_REQUEST = 2
const SYNC_PROTOCOL_VERSION = 2

/**
 * Stage-to-model mapping for upsert routing.
 * The Cloud API returns stage names; we map them to Prisma model names.
 */
// FK-safe import order: SQLite enforces foreign keys, so every referenced
// model must be imported BEFORE the models that reference it. Stages are
// sorted by this canonical order regardless of the order the cloud returns
// them in (spec §29: deterministic, race-free imports).
const FK_SAFE_STAGE_ORDER = [
  'users', 'subscriptionPlans', 'planFeatures', 'agency', 'branches', 'services', 'agencyStaff', 'counters', 'queueSettings', 'reservations', 'transactions', 'smsSettings', 'paymentSettings', 'notifications', 'announcements', 'globalAnnouncements', 'reviews', 'favorites', 'faqs', 'agencyCategories',
]

function _sortStagesFkSafe(stages) {
  if (!Array.isArray(stages)) return stages
  return stages.slice().sort((a, b) => {
    const ia = FK_SAFE_STAGE_ORDER.indexOf(a && a.id)
    const ib = FK_SAFE_STAGE_ORDER.indexOf(b && b.id)
    return (ia === -1 ? 9999 : ia) - (ib === -1 ? 9999 : ib)
  })
}

const STAGE_MODEL_MAP = {
  agency:           'Agency',
  users:            'User',
  services:         'Service',
  branches:         'Branch',
  counters:         'Counter',
  agencyStaff:      'AgencyStaff',
  queueSettings:    'QueueSettings',
  // Task 4-b (PARITY_SYNC_AUDIT §5-5): previously-missing stages. Local
  // Prisma models verified in packages/db/prisma/schema.prisma
  // (Favorite:551, GlobalAnnouncement:582, SmsSettings:595, FAQ:670,
  // PaymentSettings:689, PlanFeature:196). All use 'id' as unique key
  // (MODEL_UNIQUE_KEYS fallback below handles the upsert routing).
  smsSettings:      'SmsSettings',
  paymentSettings:  'PaymentSettings',
  reservations:     'Reservation',
  reviews:          'Review',
  favorites:        'Favorite',
  faqs:             'FAQ',
  notifications:    'Notification',
  announcements:    'Announcement',
  globalAnnouncements: 'GlobalAnnouncement',
  transactions:     'Transaction',
  subscriptionPlans: 'SubscriptionPlan',
  planFeatures:     'PlanFeature',
  // Task 42-a: user-created agency fields (shared dictionary, global model)
  agencyCategories: 'AgencyCategory',
}

// ─── Module State ───────────────────────────────────────────────────────────

let _activeSync = null  // { syncId, agencyId, cloudUrl, authToken, db, emitFn, abortController }

// ─── Task 46: [SyncDiag] diagnostics ring buffer + live progress ────────────
// The user-facing ask: "enhance console log to help find the issue with the
// branches in the desktop app". EVERY import-relevant event now flows through
// _diagPush → console ([SyncDiag]-prefixed, greppable) AND a bounded ring
// buffer exposed by GET /api/sync/initial-sync/status + /api/sync/diagnostics,
// so a support session can see exactly what the last run did without
// reproducing it.
const _diagLog = []
const _DIAG_LOG_MAX = 300
let _lastProgress = null

const CORE_DIAG_MODELS = new Set(['agency', 'users', 'branches', 'services', 'counters', 'agencyStaff'])

function _diagPush(level, msg) {
  const entry = { at: new Date().toISOString(), level, msg: String(msg).substring(0, 600) }
  _diagLog.push(entry)
  if (_diagLog.length > _DIAG_LOG_MAX) _diagLog.splice(0, _diagLog.length - _DIAG_LOG_MAX)
  const line = `[SyncDiag] ${entry.msg}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/**
 * Task 46: branch-focused pre-flight diagnostic — before the first batch of
 * a core stage is imported, run ONE sample record through the sanitizer and
 * log exactly what would be dropped and why. A "0 branches imported" report
 * can now be answered from the log alone (cloud sent 0? dropped keys?
 * null-on-not-null? relation objects?).
 */
function _diagStageSample(stageId, modelName, records) {
  if (!CORE_DIAG_MODELS.has(stageId) || !Array.isArray(records) || records.length === 0) return
  const sample = records[0]
  try {
    const preview = sanitizeSyncRecord(modelName, sample)
    _diagPush('info', `stage=${stageId} model=${modelName} fetched=${records.length} sampleId=${sample && sample.id} sampleKeys=[${Object.keys(sample || {}).join(',')}]`)
    if (preview.dropped.length > 0) {
      _diagPush('warn', `stage=${stageId} record=${sample && sample.id} sanitizer drops: ${formatDropped(preview.dropped)}`)
    }
  } catch (e) {
    _diagPush('warn', `stage=${stageId} sample diagnostic failed: ${e.message}`)
  }
}

/**
 * Task 46: post-stage table count — the log now states the LOCAL table count
 * after each core stage so "imported N but the list is empty" is instantly
 * attributable (0 imported vs N imported-but-not-rendered).
 */
async function _diagStageCount(stageId, modelName, db, agencyId) {
  if (!CORE_DIAG_MODELS.has(stageId)) return
  try {
    const modelAccessors = {
      agency: 'agency', users: 'user', branches: 'branch',
      services: 'service', counters: 'counter', agencyStaff: 'agencyStaff',
    }
    const accessor = modelAccessors[stageId]
    if (!accessor || !db[accessor]) return
    let count = 0
    if (stageId === 'counters') {
      count = await db.counter.count({ where: { branch: { agencyId } } })
    } else if (stageId === 'agency' || stageId === 'users') {
      count = await db[accessor].count()
    } else {
      count = await db[accessor].count({ where: { agencyId } })
    }
    _diagPush('info', `stage=${stageId} done — local ${modelName} table count for agency=${agencyId}: ${count}`)
  } catch (e) {
    _diagPush('warn', `stage=${stageId} local count failed: ${e.message}`)
  }
}

// ─── Cloud HTTP Helpers ─────────────────────────────────────────────────────

/**
 * POST with exponential backoff retry and error classification.
 *
 * Error classification:
 *   - Network errors  → retry with backoff
 *   - 401/403         → stop sync, emit SYNC_ERROR with auth failure (no retry)
 *   - 400             → stop sync, emit SYNC_ERROR with validation failure (no retry)
 *   - 5xx             → retry with backoff
 *   - Database error  → handled by caller
 */
/**
 * GET with the same auth/error contract as _cloudPost (Task 43).
 * Used by the empty-stage reconciliation importer, which reads the cloud's
 * canonical list endpoints (GET /api/agency/branches, GET /api/services)
 * instead of trusting a stage that came back empty.
 */
async function _cloudGet(url, authToken, options = {}) {
  const { signal } = options
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${authToken}` },
      signal: signal || AbortSignal.timeout(30000),
    })
    if (response.status === 401 || response.status === 403) {
      const err = new Error(`Cloud GET ${url} rejected auth (HTTP ${response.status})`)
      err.isAuthFailure = true
      throw err
    }
    if (!response.ok) {
      throw new Error(`Cloud GET ${url} failed (HTTP ${response.status})`)
    }
    return await response.json().catch(() => null)
  } catch (e) {
    if (e.isAuthFailure) throw e
    throw new Error(`Cloud GET ${url} error: ${e.message}`)
  }
}

async function _cloudPost(url, body, authToken, options = {}) {
  const { signal } = options
  let backoff = INITIAL_BACKOFF_MS
  let lastError = null
  let serverErrorRetries = 0

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_REQUEST; attempt++) {
    if (signal?.aborted) throw new Error('Aborted')

    try {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      }
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal || AbortSignal.timeout(30000),
      })

      if (!response.ok) {
        let errorDetail = response.statusText
        try {
          const errData = await response.json()
          errorDetail = errData.error || errData.message || errorDetail
        } catch { /* ignore */ }

        // 401/403 — auth failure, never retry
        if (response.status === 401 || response.status === 403) {
          const err = new Error(`AUTH_FAILURE: Cloud API ${response.status}: ${errorDetail}`)
          err.isAuthFailure = true
          throw err
        }

        // 400 — validation failure, never retry
        if (response.status === 400) {
          const err = new Error(`VALIDATION_FAILURE: Cloud API 400: ${errorDetail}`)
          err.isValidationFailure = true
          throw err
        }

        // 5xx or other — retry.
        // Task 7-b live-E2E fix: 5xx gets a SHORT retry budget (2 attempts).
        // Deterministic server errors (e.g. the live cloud's initial-data
        // handler selects a syncVersion column that no longer exists for 6
        // non-mandatory stages → guaranteed 500) never heal, and the old
        // full 5-attempt backoff (~31s) per broken stage pushed the whole
        // initial import past any reasonable launch budget. Transient
        // outages remain covered: every failed stage is retried by the next
        // runInitialSync/run, and mandatory-stage failures block READY.
        if (response.status >= 500) {
          serverErrorRetries++
          if (serverErrorRetries > MAX_5XX_RETRIES_PER_REQUEST) {
            const err = new Error(`Cloud API ${response.status}: ${errorDetail}`)
            err.isServerError = true
            throw err
          }
        }
        lastError = new Error(`Cloud API ${response.status}: ${errorDetail}`)
      } else {
        return await response.json()
      }
    } catch (e) {
      if (e.name === 'AbortError' || e.message === 'Aborted') throw e
      if (e.isAuthFailure || e.isValidationFailure) throw e
      // Don't retry non-retryable client errors
      if (e.message?.startsWith('Cloud API 4')) throw e
      lastError = e
    }

    // Wait before retrying (exponential backoff)
    if (attempt < MAX_RETRIES_PER_REQUEST) {
      await new Promise(resolve => setTimeout(resolve, backoff))
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
  }

  throw lastError || new Error('Max retries exceeded')
}

// ─── Data Transformation ────────────────────────────────────────────────────

const DATE_FIELDS = new Set([
  'joinedAt', 'calledAt', 'completedAt', 'cancelledAt', 'noShowAt',
  'pausedAt', 'createdAt', 'updatedAt', 'openedAt', 'repliedAt',
  'reviewedAt', 'lastRoleChangeAt', 'gracePeriodEndsAt',
  'subscriptionStartsAt', 'subscriptionExpiresAt', 'reminderSentAt',
  'smsReminderSentAt', 'skippedAt', 'reclaimRequestedAt', 'qrClaimedAt',
  'offlineCreatedAt', 'lastActiveAt', 'resolvedAt',
  'sentAt', 'scheduledAt', 'expiresAt', 'startsAt',
])

/**
 * Convert a cloud API record to a format suitable for local SQLite upsert.
 * - Convert ISO date strings to Date objects
 * - Strip undefined values
 * - Strip per-model sync-excluded fields (authentication secrets — Task 14)
 */
function _transformRecord(record, modelName) {
  const excluded = modelName ? MODEL_SYNC_EXCLUDED_FIELDS[modelName] : null

  // Task 46: schema-aware sanitize FIRST — drops unknown columns (relation
  // objects, _count, fields the local schema lacks) and null values on NOT
  // NULL columns (their DEFAULT applies instead), repairs type drift. NULL
  // on nullable columns is preserved: "not set by the user yet" is real data.
  const sanitized = sanitizeSyncRecord(modelName, record)
  if (sanitized.dropped.length > 0 && modelName &&
      ['Branch', 'Agency', 'User', 'Service', 'Counter', 'AgencyStaff'].includes(modelName)) {
    _diagPush('warn', `sanitize ${modelName}/${record && record.id}: dropped ${formatDropped(sanitized.dropped)}`)
  }
  const source = sanitized.clean || {}

  const result = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (excluded && excluded.indexOf(key) !== -1) continue
    if (DATE_FIELDS.has(key) && typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T/)) {
      result[key] = new Date(value)
    } else {
      result[key] = value
    }
  }
  // Task 46: carry the fallback-fabrication tag (symbol prop — invisible to
  // Object.entries/JSON) so _buildUpsertData can keep fabricated values out
  // of the UPDATE branch.
  copyFallbackTags(source, result)
  // D6 fix (Task 3-b): do NOT inflate syncVersion. The cloud sends its own
  // syncVersion per record and the incremental-sync conflict detector compares
  // stored vs cloud values — storing cloud+1 made EVERY later cloud update
  // look like a conflict (unbounded _sync_conflicts growth, all 'pending').
  // Task 7-b live-E2E fix: do NOT inject syncVersion/syncedAt here at all.
  // The v2 schema (packages/db) has NO syncVersion column on business models
  // (it lives only on the SyncChange log) and syncedAt exists only on
  // Reservation — forcing them into every record made EVERY Prisma upsert
  // throw "Unknown argument" and every raw fallback fail with
  // "no such column", so nothing was ever imported.
  return result
}

// ─── Model-Specific Upsert Logic ────────────────────────────────────────────

/**
 * Fields that must NEVER be persisted from the sync feed, per model
 * (Task 14 — User sync/auth contract). The cloud already excludes them
 * (explicit USER_SYNC projection + REDACTED_FIELDS), but the local engine
 * ALSO refuses them here so an authentication secret can never land in
 * local SQLite even if a future/other cloud build regresses. Applies
 * generically to every role (CUSTOMER, AGENCY_OWNER, AGENCY_STAFF,
 * SUPER_ADMIN) — the sync contract is identical for all of them; only the
 * user's authorization/agency relationship differs.
 */
const MODEL_SYNC_EXCLUDED_FIELDS = {
  User: ['passwordHash', 'fcmToken'],
}

/**
 * Map of Prisma model names to their unique key fields (for upsert `where` clause).
 * Most models use `id` as the unique key. Models with compound keys are listed explicitly.
 */
const MODEL_UNIQUE_KEYS = {
  Agency:           ['id'],
  User:             ['id'],
  Service:          ['id'],
  Branch:           ['id'],
  Counter:          ['id'],
  AgencyStaff:      ['id'],
  QueueSettings:    ['id'],
  Reservation:      ['id'],
  Review:           ['id'],
  Notification:     ['id'],
  Announcement:     ['id'],
  Transaction:      ['id'],
  SubscriptionPlan: ['id'],
}

/**
 * Fields that should be excluded from upsert `update` data
 * (e.g., fields that are immutable or cause issues on update).
 */
const MODEL_IMMUTABLE_FIELDS = new Set([
  'id',
  'createdAt',
])

/**
 * Build upsert data for a given model and record.
 * Returns { where, update, create } for Prisma upsert.
 */
function _buildUpsertData(modelName, rawRecord) {
  const record = _transformRecord(rawRecord, modelName)
  const id = record.id
  if (!id) return null

  const uniqueFields = MODEL_UNIQUE_KEYS[modelName] || ['id']
  const where = {}
  for (const field of uniqueFields) {
    where[field] = record[field]
  }

  // For create, include all fields
  const create = { ...record }

  // Task 46: values the sanitizer FABRICATED (fallbacks for NOT NULL
  // columns the cloud sent null or omitted) are CREATE-ONLY — the UPDATE
  // branch must never push them, or a drifted cloud payload would reset
  // the user's real category/customCode on every sync.
  const createOnlyKeys = getFallbackKeys(record)

  // For update, exclude immutable fields, the unique key fields, and
  // create-only fallbacks
  const update = {}
  for (const [key, value] of Object.entries(record)) {
    if (MODEL_IMMUTABLE_FIELDS.has(key)) continue
    if (uniqueFields.includes(key)) continue
    if (createOnlyKeys.indexOf(key) !== -1) continue
    update[key] = value
  }

  return { where, update, create }
}

/**
 * Idempotent upsert for a single record using Prisma model.upsert().
 * This ensures running the same batch twice produces the same result.
 */
async function _upsertRecord(tx, modelName, rawRecord) {
  const upsertData = _buildUpsertData(modelName, rawRecord)
  if (!upsertData) return false

  try {
    const model = tx[modelName]
    if (!model || typeof model.upsert !== 'function') {
      // Fallback to raw SQL if model not available in Prisma client
      return await _upsertRecordRaw(tx, modelName, rawRecord)
    }

    await model.upsert({
      where: upsertData.where,
      update: upsertData.update,
      create: upsertData.create,
    })
    return true
  } catch (e) {
    // Part J: classification — the caller decides defer vs retry vs fatal.
    // Dependency (FK-ordering) failures are RETURNED as false so the batch
    // can defer them durably; every other error is RETHROWN (schema
    // mismatch / validation / malformed data must fail the stage, never
    // masquerade as "deferred").
    if (_isFkOrderingError(e) || _isTransientDbError(e)) {
      console.warn(`[InitialSync] Upsert failed (recoverable) for ${modelName}/${rawRecord.id}: ${e.message.substring(0, 160)}`)
      return false
    }
    console.error(`[InitialSync] FATAL upsert error for ${modelName}/${rawRecord.id}: ${e.message.substring(0, 240)}`)
    throw e
  }
}

/** Transient SQLite contention — retryable in place (Part J). */
function _isTransientDbError(err) {
  const msg = String((err && err.message) || err || '')
  return /SQLITE_BUSY|database is locked|SQLITE_LOCKED/i.test(msg)
}

/**
 * Fallback raw SQL upsert for models not in the Prisma client.
 */
async function _upsertRecordRaw(tx, modelName, rawRecord) {
  const record = _transformRecord(rawRecord, modelName)
  const id = record.id
  if (!id) return false

  try {
    const existing = await tx.$queryRawUnsafe(
      `SELECT id FROM "${modelName}" WHERE id = ? LIMIT 1`, id
    ).catch(() => null)

    const fields = Object.keys(record).filter(k => k !== 'id')
    const values = fields.map(k => {
      const v = record[k]
      if (v === null || v === undefined) return null
      if (v instanceof Date) return v.toISOString()
      if (typeof v === 'boolean') return v ? 1 : 0
      if (typeof v === 'object') return JSON.stringify(v)
      return v
    })

    if (existing && existing.length > 0) {
      const setClauses = fields.map(f => `"${f}" = ?`).join(', ')
      await tx.$executeRawUnsafe(
        `UPDATE "${modelName}" SET ${setClauses} WHERE id = ?`,
        ...values, id
      )
    } else {
      const colList = ['id', ...fields.map(f => `"${f}"`)].join(', ')
      const placeholders = ['?', ...fields.map(() => '?')].join(', ')
      await tx.$executeRawUnsafe(
        `INSERT OR IGNORE INTO "${modelName}" (${colList}) VALUES (${placeholders})`,
        id, ...values
      )
    }
    return true
  } catch (e) {
    console.warn(`[InitialSync] Raw upsert failed for ${modelName}/${rawRecord.id}: ${e.message}`)
    return false
  }
}

/**
 * Upsert a batch of records into a Prisma model using $transaction.
 * Each record is upserted individually for idempotency.
 * Returns the count of successfully upserted records.
 */
const MAX_DEFERRED_RECORDS = 5000

/**
 * Detect FK-ordering failures: the record references a row that has not
 * been imported yet (e.g. Agency.ownerId → User). These are retried once
 * after ALL stages have completed (see runInitialSync's deferred pass) —
 * by then their parents exist.
 */
function _isFkOrderingError(err) {
  const msg = String((err && err.message) || err || '')
  const clean = msg.replace(/\x1b\[[0-9;]*m/g, '')
  return /foreign key/i.test(clean) || /P2003/.test(clean)
}

/**
 * Batch upsert. Returns { upserted, deferred } — deferred records failed
 * with FK-ordering errors and are retried after all stages complete.
 */
async function _upsertBatch(db, modelName, records, deferredOut, ctx) {
  ctx = ctx || {}
  if (!records || records.length === 0) return { upserted: 0, deferred: 0 }

  let upserted = 0
  let deferred = 0
  await db.$transaction(async (tx) => {
    for (const rawRecord of records) {
      let success = false
      // Part J: transient SQLite contention retries in place (up to 3x).
      for (let attempt = 0; attempt < 3 && !success; attempt++) {
        success = await _upsertRecord(tx, modelName, rawRecord)
        if (!success && attempt < 2) {
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)))
        }
      }
      if (success) {
        upserted++
      } else if (ctx.agencyId) {
        // Part K: durable deferral INSIDE the same transaction — a crash can
        // never lose a dependency-blocked record. Nothing stays in memory.
        await _persistDeferredRecord(tx, ctx, modelName, rawRecord)
        deferred++
        if (deferredOut) deferredOut.push({ modelName, rawRecord })
      } else if (deferredOut && deferredOut.length < MAX_DEFERRED_RECORDS) {
        deferredOut.push({ modelName, rawRecord })
        deferred++
      }
    }
  }, { maxWait: 5000, timeout: 30000 })

  return { upserted, deferred }
}

/**
 * Part K: persist a dependency-blocked record to _deferred_changes inside the
 * current transaction. `source='initial-sync'` + stage recorded for the
 * READY gate (unresolved mandatory deferrals block READY).
 */
async function _persistDeferredRecord(tx, ctx, modelName, rawRecord) {
  await tx.$executeRawUnsafe(
    'INSERT INTO "_deferred_changes" ' +
    '("id","agencyId","source","sequence","stage","model","recordId","operation","payload","dependencyError","retryCount","firstSeenAt","status","lastError") ' +
    "VALUES (?, ?, 'initial-sync', NULL, ?, ?, ?, 'create', ?, ?, 0, ?, 'PENDING', ?)",
    require('crypto').randomUUID(),
    ctx.agencyId || '',
    ctx.stage || null,
    modelName,
    String(rawRecord && rawRecord.id || ''),
    JSON.stringify(rawRecord || {}),
    'FK/dependency ordering during initial import',
    new Date().toISOString(),
    'deferred during initial import'
  )
}

// ─── AgencyLocalState Helpers ────────────────────────────────────────────────

/**
 * Get or create the AgencyLocalState record for an agency.
 */
async function _getOrCreateLocalState(db, agencyId) {
  const state = await db.agencyLocalState.findUnique({
    where: { agencyId },
  })

  if (state) return state

  // Create initial state
  return db.agencyLocalState.create({
    data: { agencyId },
  })
}

/**
 * Update the AgencyLocalState for an agency.
 */
async function _updateLocalState(db, agencyId, updates) {
  return db.agencyLocalState.upsert({
    where: { agencyId },
    update: updates,
    create: { agencyId, ...updates },
  })
}

// ─── _sync_meta Helpers (for incremental sync bridge) ──────────────────────

async function _ensureMetaTable(db) {
  try {
    await db.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS "_sync_meta" (' +
      '"key" TEXT PRIMARY KEY,' +
      '"value" TEXT NOT NULL' +
      ')'
    )
  } catch (e) {
    console.error('[InitialSync] Failed to create _sync_meta table:', e.message)
  }
}

async function _setMeta(db, key, value) {
  try {
    await db.$executeRawUnsafe(
      'INSERT INTO "_sync_meta" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, String(value)
    )
  } catch (e) {
    console.error('[InitialSync] _setMeta error:', e.message)
  }
}

async function _getMeta(db, key) {
  try {
    const rows = await db.$queryRawUnsafe('SELECT value FROM "_sync_meta" WHERE key = ?', key)
    return rows?.[0]?.value || null
  } catch {
    return null
  }
}

// ─── Integrity Validation ───────────────────────────────────────────────────

/**
 * After all stages complete, validate that essential data exists.
 *
 * MANDATORY (issues → FAIL the workspace): the Agency row itself and real
 * referential corruption (orphan FKs).
 *
 * WARNINGS (warnings → logged, never fail): empty services/branches/counters.
 * A freshly wizard-created agency legitimately has NO branches and NO
 * counters (they are created later in the dashboard) and may even have zero
 * services — treating emptiness as a mandatory failure marked every new
 * workspace FAILED forever, so it never reached READY, the Part-D pull gate
 * stayed shut, and the profile/settings/QR pages rendered empty.
 */
/**
 * Task 43 — empty-business-stage reconciliation.
 *
 * Live incident (desktop log): a fresh local DB logged in to a cloud that
 * HAS branches visible in the webapp, yet the initial-data `branches`/`services`
 * stages delivered 0 records ("No branches imported" integrity warning) and
 * the workspace went READY with an empty branch list — the exact "desktop
 * shows no branches" report. The staged importer is proven healthy (E2E
 * imports what the cloud sends), so the remaining failure mode is a
 * stage-level gap (old/stale feed, per-stage filtering, drifted cloud build).
 *
 * This step cross-checks the TWO critical business stages against the
 * cloud's CANONICAL list endpoints (the same HTTP reads the webapp UI uses)
 * and imports directly when the stage came back empty but the endpoint
 * still returns rows. It also makes the warning text HONEST about which
 * side is empty, so "no branches yet" can never again be silent.
 */
/**
 * Project a RAW cloud list-endpoint row (GET /api/agency/branches etc.)
 * down to the flat scalar shape the staged import path receives from
 * serializeForCloud. List routes add relational payloads (_count includes,
 * nested objects) that the upsert contract cannot persist — strip them.
 * Task 44: null RELATION names (Counter.staff: null, Counter.currentReservation:
 * null, …) also crash the upsert ("Unknown argument `staff`") — strip any
 * key that names a Prisma relation across the synced models. The FK scalar
 * columns (staffId, branchId, …) are untouched, so null-clearing semantics
 * are preserved.
 */
const SYNC_RELATION_NAMES = new Set([
  // Agency
  'owner', 'branches', 'services', 'counters', 'staffMembers', 'staff', 'queueSettings',
  'reservations', 'workingHours', 'announcements', 'reviews', 'favorites', 'transactions',
  'subscriptionPlan', 'smsSettings', 'paymentSettings', 'smsPurchases',
  // User
  'ownedAgencies', 'staffAgencies', 'auditLogs', 'notifications', 'devices',
  'deviceCredentials', 'verificationCodes', 'managedTransactions', 'smsPurchase',
  // AgencyStaff
  'userRef', 'agencyRef', 'branchRef', 'counterRef',
  // Branch / Counter / Reservation
  'agency', 'branch', 'countersList', 'currentReservation', 'service', 'counter',
  'user', 'reservation', 'reviewsList', 'servedReservations',
])

function _sanitizeListRowForUpsert(row) {
  if (!row || typeof row !== 'object') return row
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (k === '_count') continue
    if (SYNC_RELATION_NAMES.has(k)) continue
    if (v !== null && typeof v === 'object') continue // nested relations/arrays are not upsertable scalars
    out[k] = v
  }
  return out
}

async function _reconcileEmptyBusinessStages(db, agencyId, cloudUrl, authToken, signal, emit) {
  const report = {}
  const targets = [
    { stage: 'branches', model: 'Branch', localPath: 'branch', localWhere: { agencyId }, url: `${cloudUrl}/api/agency/branches?agencyId=${encodeURIComponent(agencyId)}`, keys: ['branches', 'data'] },
    { stage: 'services', model: 'Service', localPath: 'service', localWhere: { agencyId }, url: `${cloudUrl}/api/services?agencyId=${encodeURIComponent(agencyId)}`, keys: ['services', 'data'] },
    // Task 44: counters joined the reconciliation set — a Counter whose
    // Branch arrives only through this reconciliation is exactly the shape
    // that produced the endless FK-787 deferral in the field. FK-blocked
    // counter rows are durably deferred by _upsertBatch (ctx.agencyId set)
    // and the background retry pass heals them once the branch lands.
    // NOTE: Counter has NO agencyId column — the local count goes through
    // the branch relation instead.
    { stage: 'counters', model: 'Counter', localPath: 'counter', localWhere: { branch: { agencyId } }, url: `${cloudUrl}/api/agency/counters?agencyId=${encodeURIComponent(agencyId)}`, keys: ['counters', 'data'] },
  ]
  for (const t of targets) {
    let localCount = 0
    try {
      localCount = await db[t.localPath].count({ where: t.localWhere || { agencyId } })
    } catch (e) {
      console.warn(`[InitialSync] Reconciliation: local ${t.stage} count failed:`, e.message)
      continue
    }
    if (localCount > 0) {
      report[t.stage] = { localCount, cloudCount: null, reconciled: 0 }
      continue
    }
    // Local table is EMPTY — ask the cloud's canonical list endpoint.
    let cloudRows = null
    try {
      const body = await _cloudGet(t.url, authToken, { signal })
      if (body && body.success !== false) {
        for (const k of t.keys) {
          if (Array.isArray(body && body[k])) { cloudRows = body[k]; break }
        }
      }
    } catch (e) {
      console.warn(`[InitialSync] Reconciliation: cloud check for ${t.stage} failed:`, e.message)
      report[t.stage] = { localCount, cloudCount: null, reconciled: 0, cloudCheckError: e.message }
      continue
    }
    const cloudCount = Array.isArray(cloudRows) ? cloudRows.length : 0
    let reconciled = 0
    if (cloudCount > 0) {
      console.warn(`[InitialSync] RECONCILIATION: stage "${t.stage}" imported 0 rows but the cloud list endpoint reports ${cloudCount} — importing directly`)
      const sanitized = cloudRows.map(_sanitizeListRowForUpsert)
      const deferredOut = []
      try {
        const batchResult = await _upsertBatch(db, t.model, sanitized, deferredOut, { agencyId, stage: `reconciliation:${t.stage}` })
        reconciled = batchResult.upserted
        console.log(`[InitialSync] Reconciliation: imported ${reconciled}/${cloudCount} ${t.stage} record(s) directly from the cloud list endpoint`)
        emit({ type: 'SYNC_STAGE_COMPLETED', stage: `reconciliation-${t.stage}`, stageLabel: `Reconciliation (${t.stage})`, count: reconciled })
      } catch (e) {
        console.error(`[InitialSync] Reconciliation import for ${t.stage} failed:`, e.message)
      }
    }
    report[t.stage] = { localCount, cloudCount, reconciled }
  }
  return report
}

async function _validateIntegrity(db, agencyId) {
  const issues = []
  const warnings = []

  // 1. Agency must exist
  try {
    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) {
      issues.push('Agency profile missing')
    }
  } catch {
    // Fallback to raw query
    const agency = await db.$queryRawUnsafe(
      'SELECT id FROM "Agency" WHERE id = ? LIMIT 1', agencyId
    ).catch(() => [])
    if (!agency || agency.length === 0) {
      issues.push('Agency profile missing')
    }
  }

  // 2. Services — WARNING ONLY (a fresh agency can have zero services)
  try {
    const svcCount = await db.service.count({ where: { agencyId } })
    if (svcCount === 0) warnings.push('No services imported')
  } catch {
    try {
      const svcCount = await db.$queryRawUnsafe(
        'SELECT COUNT(*) as cnt FROM "Service" WHERE agencyId = ?', agencyId
      )
      const count = typeof svcCount?.[0]?.cnt === 'bigint' ? Number(svcCount[0].cnt) : (svcCount?.[0]?.cnt || 0)
      if (count === 0) warnings.push('No services imported')
    } catch { /* Service table may not exist yet */ }
  }

  // 3. Branches — WARNING ONLY (created later in the dashboard)
  try {
    const branchCount = await db.branch.count({ where: { agencyId } })
    if (branchCount === 0) warnings.push('No branches imported')
  } catch {
    try {
      const branchCount = await db.$queryRawUnsafe(
        'SELECT COUNT(*) as cnt FROM "Branch" WHERE agencyId = ?', agencyId
      )
      const count = typeof branchCount?.[0]?.cnt === 'bigint' ? Number(branchCount[0].cnt) : (branchCount?.[0]?.cnt || 0)
      if (count === 0) warnings.push('No branches imported')
    } catch { /* Branch table may not exist yet */ }
  }

  // 4. Counters — WARNING ONLY (created later, inside branches)
  try {
    // Counters are linked via branches
    const branches = await db.branch.findMany({ where: { agencyId }, select: { id: true } })
    if (branches.length > 0) {
      const counterCount = await db.counter.count({
        where: { branchId: { in: branches.map(b => b.id) } },
      })
      if (counterCount === 0) warnings.push('No counters imported')
    }
  } catch {
    // Non-fatal — counters might not be in schema yet
  }

  // 5. Foreign key: counters → branches
  try {
    const orphanCounters = await db.$queryRawUnsafe(
      'SELECT COUNT(*) as cnt FROM "Counter" c WHERE c.branchId IS NOT NULL AND c.branchId NOT IN (SELECT id FROM "Branch")'
    ).catch(() => [{ cnt: 0 }])
    const orphanCnt = typeof orphanCounters?.[0]?.cnt === 'bigint'
      ? Number(orphanCounters[0].cnt)
      : (orphanCounters?.[0]?.cnt || 0)
    if (orphanCnt > 0) {
      issues.push(`${orphanCnt} counters reference non-existent branches`)
    }
  } catch { /* non-fatal */ }

  // 6. Foreign key: agencyStaff → users
  try {
    const orphanStaff = await db.$queryRawUnsafe(
      'SELECT COUNT(*) as cnt FROM "AgencyStaff" s WHERE s.userId IS NOT NULL AND s.userId NOT IN (SELECT id FROM "User")'
    ).catch(() => [{ cnt: 0 }])
    const orphanCnt = typeof orphanStaff?.[0]?.cnt === 'bigint'
      ? Number(orphanStaff[0].cnt)
      : (orphanStaff?.[0]?.cnt || 0)
    if (orphanCnt > 0) {
      issues.push(`${orphanCnt} staff assignments reference non-existent users`)
    }
  } catch { /* non-fatal */ }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
  }
}

// ─── Main Sync Engine ───────────────────────────────────────────────────────

/**
 * Check if initial sync is needed for a given agency.
 * Returns { needsInitialSync, agencyId, status, currentStage, stages }
 * Uses AgencyLocalState table instead of _sync_meta.
 */
async function checkInitialSyncStatus(db, agencyId) {
  if (!db) {
    return { needsInitialSync: true, agencyId, status: 'NOT_INITIALIZED', currentStage: null, stages: [] }
  }

  const state = await _getOrCreateLocalState(db, agencyId)

  if (state.initializationStatus === 'READY') {
    return {
      needsInitialSync: false,
      agencyId,
      status: 'READY',
      currentStage: null,
      lastSyncAt: state.initializationCompletedAt?.getTime() || null,
      snapshotSequence: state.snapshotSequence,
    }
  }

  if (state.initializationStatus === 'INITIALIZING') {
    // In progress — check for resumable state
    return {
      needsInitialSync: true,
      agencyId,
      status: 'INITIALIZING',
      currentStage: state.currentStage,
      currentCursor: state.currentCursor,
      recordsImported: state.recordsImported,
      resumable: !!state.currentStage,
      resumeStage: state.currentStage,
      resumeCursor: state.currentCursor,
    }
  }

  if (state.initializationStatus === 'FAILED') {
    return {
      needsInitialSync: true,
      agencyId,
      status: 'FAILED',
      currentStage: state.currentStage,
      lastError: state.lastError,
      resumable: false, // Failed syncs should be restarted, not resumed
    }
  }

  // NOT_INITIALIZED or UPGRADING
  return {
    needsInitialSync: true,
    agencyId,
    status: state.initializationStatus,
    currentStage: null,
  }
}

/**
 * Run the initial sync for a given agency.
 * This is the main entry point.
 *
 * Contract:
 *   1. Discovery call (no stage) → get list of stages + snapshotSequence
 *   2. For each stage: call with stage name + cursor → get records → upsert → advance cursor → repeat until hasMore=false
 *   3. After all stages: integrity validation
 *   4. If validation passes: mark READY, store snapshotSequence for incremental sync
 *
 * @param {object} options
 * @param {string} options.agencyId - The agency ID to sync
 * @param {string} options.cloudAuthToken - Cloud API auth token
 * @param {string} options.cloudUrl - Cloud API base URL
 * @param {object} options.db - Prisma client instance
 * @param {function} options.emitFn - Event emitter function
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @returns {Promise<{success: boolean, totalRecords: number, duration: number, error?: string}>}
 */
async function runInitialSync(options) {
  const { agencyId, cloudAuthToken, cloudUrl, db, emitFn, signal } = options

  if (!agencyId || !cloudAuthToken || !cloudUrl || !db) {
    throw new Error('Missing required options: agencyId, cloudAuthToken, cloudUrl, db')
  }

  // Concurrency guard (spec §29): ONE authoritative initial-sync job per
  // agency/session. If the SAME agency is already importing, coalesce —
  // the new caller receives the in-flight run's promise instead of racing
  // a second import (duplicate imports, cursor corruption, DB locking).
  // A DIFFERENT agency legitimately needs the old run aborted.
  if (_activeSync) {
    if (_activeSync.agencyId === agencyId && !_activeSync.abortController?.signal?.aborted) {
      console.warn('[InitialSync] Initial sync already running for agency %s (syncId: %s) — coalescing into the active run',
        agencyId, _activeSync.syncId)
      return _activeSync.promise
    }
    console.warn('[InitialSync] Different agency initial sync running (syncId: %s, agencyId: %s) — aborting it before starting new sync',
      _activeSync.syncId, _activeSync.agencyId)
    if (_activeSync.abortController) {
      _activeSync.abortController.abort()
    }
    _activeSync = null
  }

  const syncId = randomUUID()
  const startTime = Date.now()

  _activeSync = {
    syncId,
    agencyId,
    cloudUrl,
    authToken: cloudAuthToken,
    db,
    emitFn: emitFn || (() => {}),
    abortController: signal ? null : new AbortController(),
    startedAt: new Date().toISOString(),
    // Self-reference used by the coalescing path above.
    promise: null,
  }
  _activeSync.promise = _runInitialSyncInner({
    agencyId, cloudAuthToken, cloudUrl, db, emitFn, signal,
  }, _activeSync, syncId, startTime)

  try {
    return await _activeSync.promise
  } finally {
    if (_activeSync && _activeSync.syncId === syncId) _activeSync = null
  }
}

/**
 * Original runInitialSync body — kept verbatim except for the concurrency
 * guard (moved into runInitialSync) and the READY fast-path which now clears
 * the active sync entry via the shared _clearActive helper.
 */
/**
 * Part AE: post-snapshot bridge. Between the snapshot (sequence S) and the
 * end of the staged import, cloud changes occurred. This closes the race by
 * pulling and applying EVERY change > S (via the incremental pull protocol,
 * using the same savepoint/tombstone/LWW apply machinery as the engine)
 * BEFORE the workspace is marked READY. Deferred failures are durably
 * persisted inside applyPullChanges.
 *
 * The engine cursor is then set to the bridge's final page sequence so no
 * change is re-missed and nothing is skipped (the ORIGINAL S is retained in
 * initialSyncSnapshotSequence for audit).
 */
async function _bridgeChangesSinceSnapshot(db, agencyId, cloudUrl, cloudAuthToken, snapshotSequence, signal, emit) {
  const syncService = require('./sync-service')
  let since = snapshotSequence
  let pages = 0
  let applied = 0
  for (let guard = 0; guard < 1000; guard++) {
    const page = await _cloudPost(`${cloudUrl}/api/sync/pull`, {
      agencyId,
      sinceSequence: since,
      limit: 500,
      protocolVersion: SYNC_PROTOCOL_VERSION,
    }, cloudAuthToken, { signal })
    if (!page?.success) throw new Error('Bridge pull failed: ' + (page?.error || 'unknown error'))
    const pageLast = typeof page.pageLastSequence === 'number'
      ? page.pageLastSequence
      : (typeof page.latestSequence === 'number' ? page.latestSequence : since)
    if (pageLast > since) {
      const result = await syncService.applyPullChanges(db, page.changes || {}, { agencyId, pageLastSequence: pageLast })
      applied += (result.applied || 0) + (result.deleted || 0)
    }
    since = pageLast
    pages++
    if (!page.hasMore) break
  }
  emit && emit({ type: 'SYNC_STAGE_COMPLETED', stage: 'snapshot-bridge', stageLabel: 'Snapshot bridge', count: applied })
  return { pages, applied, finalSequence: since }
}

async function _runInitialSyncInner(options, activeSync, syncId, startTime) {
  const { agencyId, cloudAuthToken, cloudUrl, db, emitFn, signal } = options

  const rawEmit = activeSync.emitFn
  const effectiveSignal = signal || activeSync.abortController.signal

  // Task 46: single funnel wrapper — every event updates the module-level
  // live progress snapshot (polled by the post-login loading gate via
  // GET /api/sync/initial-sync/status) and the [SyncDiag] ring buffer.
  const emit = (evt) => {
    try {
      if (evt && evt.type) {
        _lastProgress = { ...evt, agencyId, at: new Date().toISOString() }
        const bits = [`evt ${evt.type}`]
        if (evt.stage) bits.push(`stage=${evt.stage}`)
        if (evt.count != null) bits.push(`count=${evt.count}`)
        if (evt.stageIndex != null && evt.totalStages != null) bits.push(`(${evt.stageIndex + 1}/${evt.totalStages})`)
        if (evt.error) bits.push(`error=${String(evt.error).substring(0, 240)}`)
        _diagPush(evt.type === 'SYNC_ERROR' ? 'error' : (evt.type === 'SYNC_WARNING' ? 'warn' : 'info'), bits.join(' '))
      }
    } catch { /* diagnostics must never break the sync */ }
    return rawEmit(evt)
  }

  // Ensure _sync_meta table exists (for incremental sync bridge)
  await _ensureMetaTable(db)

  // ── Step 0: Read or create AgencyLocalState ──────────────────────────────
  let localState = await _getOrCreateLocalState(db, agencyId)

  // Check if already initialized
  if (localState.initializationStatus === 'READY') {
    emit({ type: 'SYNC_COMPLETED', agencyId, totalRecords: 0, duration: 0, alreadyInitialized: true })
    _activeSync = null
    return { success: true, totalRecords: 0, duration: 0, alreadyInitialized: true }
  }

  // ── Step 1: Discovery call ──────────────────────────────────────────────
  // Get list of stages and snapshotSequence from the cloud API
  const discoveryUrl = `${cloudUrl}/api/sync/initial-data`
  let discoveryResult

  try {
    discoveryResult = await _cloudPost(discoveryUrl, {
      agencyId,
      protocolVersion: SYNC_PROTOCOL_VERSION,
    }, cloudAuthToken, { signal: effectiveSignal })
  } catch (e) {
    // Mark as FAILED
    await _updateLocalState(db, agencyId, {
      initializationStatus: 'FAILED',
      lastError: `Discovery failed: ${e.message}`,
      initializationSessionId: syncId,
    })
    emit({ type: 'SYNC_ERROR', stage: 'discovery', error: e.message, retryable: !e.isAuthFailure && !e.isValidationFailure })
    _activeSync = null
    return { success: false, totalRecords: 0, duration: Date.now() - startTime, error: `Discovery failed: ${e.message}` }
  }

  if (!discoveryResult?.success || !discoveryResult?.stages?.length) {
    const errMsg = discoveryResult?.error || 'No stages returned from discovery'
    await _updateLocalState(db, agencyId, {
      initializationStatus: 'FAILED',
      lastError: errMsg,
      initializationSessionId: syncId,
    })
    emit({ type: 'SYNC_ERROR', stage: 'discovery', error: errMsg, retryable: false })
    _activeSync = null
    return { success: false, totalRecords: 0, duration: Date.now() - startTime, error: errMsg }
  }

  const cloudStages = _sortStagesFkSafe(discoveryResult.stages)
  // Part E: ONE immutable snapshot per import. A resumed run reuses the
  // snapshot captured when the import STARTED (a fresh value would silently
  // widen the snapshot mid-import while part of the data is relative to the
  // older one).
  const snapshotSequence = (localState.initializationStatus === 'INITIALIZING' && localState.snapshotSequence > 0)
    ? localState.snapshotSequence
    : (discoveryResult.snapshotSequence || 0)

  // ── Step 2: Transition to INITIALIZING ──────────────────────────────────
  // Check for resumable state
  const resumeFromStage = localState.initializationStatus === 'INITIALIZING' ? localState.currentStage : null
  // Part G: the stage/page cursor is the OPAQUE STRING tuple from the cloud
  // (currentStageCursor) — completely separate from the integer global
  // SyncChange sequence cursor. Legacy currentCursor (Int) is no longer read.
  const resumeCursor = localState.initializationStatus === 'INITIALIZING' ? localState.currentStageCursor : null

  await _updateLocalState(db, agencyId, {
    initializationStatus: 'INITIALIZING',
    initializationSessionId: syncId,
    initializationStartedAt: localState.initializationStartedAt || new Date(),
    currentStage: resumeFromStage || cloudStages[0]?.id || null,
    currentStageCursor: resumeCursor,
    snapshotSequence,
    // NOTE: syncProtocolVersion removed — the AgencyLocalState model in
    // packages/db/prisma/schema.prisma has no such column and the upsert
    // threw PrismaClientValidationError (found in live E2E, Task 7-b).
  })

  const totalStages = cloudStages.length
  let totalRecords = localState.initializationStatus === 'INITIALIZING' ? (localState.recordsImported || 0) : 0
  let batchNumber = localState.initializationStatus === 'INITIALIZING' ? (localState.currentBatch || 0) : 0

  // Emit start event
  emit({
    type: 'SYNC_STARTED',
    agencyId,
    syncId,
    totalStages,
    snapshotSequence,
    resuming: !!resumeFromStage,
    resumeStage: resumeFromStage || null,
  })

  // ── Step 3: Process each stage ──────────────────────────────────────────
  const startStageIndex = resumeFromStage
    ? cloudStages.findIndex(s => s.id === resumeFromStage)
    : 0

  const effectiveStartIndex = Math.max(0, startStageIndex)

  // Records whose import was blocked by FK ordering (references to rows that
  // were not imported yet). Retried once after ALL stages complete.
  const deferredRecords = []

  for (let i = effectiveStartIndex; i < cloudStages.length; i++) {
    if (effectiveSignal?.aborted) {
      await _updateLocalState(db, agencyId, {
        lastError: 'Aborted by user',
      })
      emit({ type: 'SYNC_ERROR', stage: cloudStages[i].id, error: 'Aborted by user', retryable: false })
      _activeSync = null
      return { success: false, totalRecords, duration: Date.now() - startTime, error: 'Aborted' }
    }

    const stage = cloudStages[i]
    const modelName = STAGE_MODEL_MAP[stage.id]
    const isMandatory = stage.mandatory !== false
    const isResumeStage = i === effectiveStartIndex

    // Update current stage in state
    await _updateLocalState(db, agencyId, {
      currentStage: stage.id,
      currentStageCursor: isResumeStage ? resumeCursor : null,
    })

    // Emit stage started
    emit({
      type: 'SYNC_STAGE_STARTED',
      stage: stage.id,
      stageLabel: stage.label || stage.id,
      stageIndex: i,
      totalStages,
      mandatory: isMandatory,
    })

    try {
      let stageCount = 0
      let cursor = isResumeStage ? resumeCursor : null
      let hasMore = true

      // Process paginated data for this stage
      while (hasMore) {
        if (effectiveSignal?.aborted) throw new Error('Aborted')

        // Fetch page from cloud
        // Task 7-b live-E2E fix: the cloud validates cursor as
        // z.string().optional() — a JSON null is REJECTED with 400. Omit the
        // field entirely until a real (string) cursor exists.
        const response = await _cloudPost(discoveryUrl, {
          agencyId,
          stage: stage.id,
          cursor: cursor || undefined,
          pageSize: PAGE_SIZE,
          protocolVersion: SYNC_PROTOCOL_VERSION,
          // Part E: echo the pinned snapshot so EVERY page shares one snapshot.
          snapshotSequence,
        }, cloudAuthToken, { signal: effectiveSignal })

        if (!response?.success) {
          throw new Error(response?.error || `Stage ${stage.id} fetch failed`)
        }

        const records = response.records || []
        const nextCursor = response.nextCursor || null
        hasMore = response.hasMore === true

        // Task 43: make the per-stage fetch VISIBLE in the main log (the
        // evt printer only logs types, so a stage that quietly got 0 rows
        // from the cloud was indistinguishable from one that got 50).
        console.log(`[InitialSync] stage ${stage.id}: fetched ${records.length} record(s) from cloud (page hasMore=${hasMore})`)

        // Task 46: branch-focused pre-flight diagnostics — sample keys + what
        // the sanitizer would drop, for the FIRST page of each core stage.
        if (cursor === null || cursor === undefined) {
          _diagStageSample(stage.id, modelName, records)
        }

        if (records.length === 0 && !hasMore) {
          break
        }

        // If records is empty but hasMore was true, correct it
        if (records.length === 0) {
          hasMore = false
          break
        }

        // Upsert batch in transaction (FK-blocked records are deferred
        // to the post-pass retry instead of being silently dropped)
        batchNumber++
        const batchResult = await _upsertBatch(db, modelName, records, deferredRecords, { agencyId, stage: stage.id })
        stageCount += batchResult.upserted
        totalRecords += batchResult.upserted

        // Task 46: post-batch visibility for core stages — imported vs
        // deferred vs the resulting LOCAL table count ("0 imported" and
        // "imported but list empty" are now distinguishable from the log).
        if (batchResult.deferred > 0 && CORE_DIAG_MODELS.has(stage.id)) {
          _diagPush('warn', `stage=${stage.id} batch #${batchNumber}: ${batchResult.deferred} record(s) deferred (FK/dependency) — they retry after all stages finish`)
        }
        if (CORE_DIAG_MODELS.has(stage.id) && !hasMore) {
          await _diagStageCount(stage.id, modelName, db, agencyId)
        }

        // Advance cursor and update progress (Part G: string stage cursor)
        cursor = nextCursor
        await _updateLocalState(db, agencyId, {
          currentStageCursor: cursor,
          recordsImported: totalRecords,
          // NOTE: currentBatch removed — no such column on AgencyLocalState
          // (PrismaClientValidationError, found in live E2E, Task 7-b).
        })

        // Determine if more pages
        // The server tells us via hasMore; also check if we got fewer than pageSize
        if (!hasMore && records.length < PAGE_SIZE) {
          hasMore = false
        }

        // Emit progress
        const stageTotal = response.total || null
        const percentage = stageTotal
          ? Math.min(100, Math.round((stageCount / stageTotal) * 100))
          : (hasMore ? Math.round((stageCount / (stageCount + PAGE_SIZE)) * 100) : 100)

        emit({
          type: 'SYNC_STAGE_PROGRESS',
          stage: stage.id,
          current: stageCount,
          total: stageTotal,
          percentage,
          batch: batchNumber,
        })
      }

      // Clear cursor for completed stage
      await _updateLocalState(db, agencyId, {
        currentStageCursor: null,
      })

      // Emit stage completed
      emit({
        type: 'SYNC_STAGE_COMPLETED',
        stage: stage.id,
        stageLabel: stage.label || stage.id,
        count: stageCount,
      })
    } catch (e) {
      // Auth/validation failures — stop entirely
      if (e.isAuthFailure || e.isValidationFailure) {
        await _updateLocalState(db, agencyId, {
          initializationStatus: 'FAILED',
          lastError: e.message,
        })
        emit({ type: 'SYNC_ERROR', stage: stage.id, error: e.message, retryable: false, authFailure: e.isAuthFailure })
        _activeSync = null
        return {
          success: false,
          totalRecords,
          duration: Date.now() - startTime,
          error: e.message,
          failedStage: stage.id,
        }
      }

      // Check if this is a mandatory stage
      if (isMandatory) {
        await _updateLocalState(db, agencyId, {
          initializationStatus: 'FAILED',
          lastError: `Mandatory stage "${stage.id}" failed: ${e.message}`,
        })

        emit({
          type: 'SYNC_ERROR',
          stage: stage.id,
          stageLabel: stage.label || stage.id,
          error: e.message,
          retryable: true,
        })

        _activeSync = null
        return {
          success: false,
          totalRecords,
          duration: Date.now() - startTime,
          error: `Mandatory stage "${stage.label || stage.id}" failed: ${e.message}`,
          failedStage: stage.id,
        }
      }

      // Non-mandatory stage failure — log and continue
      console.warn(`[InitialSync] Non-mandatory stage "${stage.id}" failed:`, e.message)
      emit({
        type: 'SYNC_ERROR',
        stage: stage.id,
        stageLabel: stage.label || stage.id,
        error: e.message,
        retryable: true,
        skipped: true,
      })
    }
  }

  // ── Step 3b: Deferred retry pass (Part I/K — two-phase circular import) ──
  // Records that failed during staged import because they referenced rows
  // imported LATER (the Counter.currentReservationId ↔ Reservation.counterId
  // cycle, or discovery stage order differing from FK order) are durably
  // queued in _deferred_changes (source='initial-sync'). This pass retries
  // them IN ROUNDS until no further progress (two-phase import for the
  // circular nullable relations): parents land, then children resolve.
  // Still-failing rows stay PENDING (or QUARANTINE on non-FK errors).
  //
  // P0-3 (READY integrity): the accounting below covers ALL deferred sources —
  // the post-snapshot bridge (Step 4c) applies pull pages through the engine,
  // which persists failures with source='pull'. A READY workspace must not
  // silently ignore those (the old gate only inspected source='initial-sync').
  const MANDATORY_READY_MODELS = new Set([
    'Agency', 'User', 'AgencyStaff', 'Branch', 'Service', 'Counter',
  ])
  let deferredOutcome = { pendingInitialSync: 0, pendingPull: 0, quarantinedAtGate: 0 }
  try {
    const syncService = require('./sync-service')
    const allDeferred = await db.$queryRawUnsafe(
      "SELECT COUNT(*) as n FROM _deferred_changes WHERE agencyId = ? AND source = 'initial-sync' AND status = 'PENDING'",
      agencyId
    ).catch(() => [{ n: 0 }])
    const deferredCount = Number(allDeferred?.[0]?.n || 0)
    if (deferredCount > 0) {
      console.log(`[InitialSync] Deferred retry pass: ${deferredCount} record(s) blocked by FK ordering`)
      let recoveredTotal = 0
      for (let round = 0; round < 4; round++) {
        const before = await db.$queryRawUnsafe(
          "SELECT COUNT(*) as n FROM _deferred_changes WHERE agencyId = ? AND source = 'initial-sync' AND status = 'PENDING'", agencyId
        )
        const beforeCount = Number(before?.[0]?.n || 0)
        if (beforeCount === 0) break
        const res = await syncService.retryDeferredChanges()
        const after = await db.$queryRawUnsafe(
          "SELECT COUNT(*) as n FROM _deferred_changes WHERE agencyId = ? AND source = 'initial-sync' AND status = 'PENDING'", agencyId
        )
        const afterCount = Number(after?.[0]?.n || 0)
        recoveredTotal += (beforeCount - afterCount)
        if (afterCount === beforeCount) break // no progress this round
      }
      totalRecords += recoveredTotal
      const remaining = await db.$queryRawUnsafe(
        "SELECT COUNT(*) as n FROM _deferred_changes WHERE agencyId = ? AND source = 'initial-sync' AND status = 'PENDING'", agencyId
      )
      const remainingCount = Number(remaining?.[0]?.n || 0)
      console.log(`[InitialSync] Deferred retry recovered ${recoveredTotal} record(s); ${remainingCount} still pending`)
      emit({ type: 'SYNC_STAGE_COMPLETED', stage: 'deferred-retry', stageLabel: 'Deferred retry', count: recoveredTotal })
    }

    // ── READY gate over ALL unresolved deferrals (any source) ─────────────
    // The bridge (Step 4c) has NOT run yet on a fresh import, so pull-source
    // rows here come from a RESUMED import's earlier bridge attempt. After
    // the bridge (Step 4c) the same check re-runs with final numbers (Step 5
    // guard below) — this placement keeps the gate BEFORE any READY flip.
    const pendingRowsAll = await db.$queryRawUnsafe(
      "SELECT id, source, stage, model, recordId, retryCount FROM _deferred_changes WHERE agencyId = ? AND status = 'PENDING' LIMIT 200", agencyId
    ).catch(() => [])
    const pendingList = pendingRowsAll || []
    const mandatoryPending = pendingList.filter((r) => MANDATORY_READY_MODELS.has(r.model))
    const nonMandatoryPending = pendingList.filter((r) => !MANDATORY_READY_MODELS.has(r.model))

    if (mandatoryPending.length > 0) {
      // These rows reference parents that never arrive (e.g. the cloud feed
      // contains a Counter whose Branch was hard-deleted). Retrying forever
      // would wedge initialization on cloud-side garbage, so they are
      // QUARANTINED with an explicit, visible reason — the integrity
      // validation below still FAILS READY when a core table ended up EMPTY.
      const feedExhausted = `feed exhausted (snapshot seq ${snapshotSequence}; parents not delivered by cloud)`
      for (const row of mandatoryPending) {
        await db.$executeRawUnsafe(
          "UPDATE _deferred_changes SET status = 'QUARANTINED', lastError = ? WHERE id = ?",
          `unresolvable at init: ${feedExhausted}`, row.id
        ).catch(() => {})
      }
      deferredOutcome.quarantinedAtGate = mandatoryPending.length
      const detail = mandatoryPending.map((r) => `${r.model}/${r.recordId}`).join(', ')
      console.warn(`[InitialSync] ${mandatoryPending.length} MANDATORY-model deferred record(s) unresolvable after all rounds → QUARANTINED (visible in db-status): ${detail}`)
      emit({ type: 'SYNC_WARNING', stage: 'deferred-retry', message: `Mandatory deferred records quarantined: ${detail}` })
    }
    deferredOutcome.pendingInitialSync = nonMandatoryPending.filter((r) => r.source === 'initial-sync').length
    deferredOutcome.pendingPull = nonMandatoryPending.filter((r) => r.source !== 'initial-sync').length
    if (nonMandatoryPending.length > 0) {
      // Non-core records (Reservation/Notification/Review/…) keep PENDING:
      // the background engine re-applies them on every cycle once their
      // parents arrive (post-READY reconciliation heals them).
      console.warn(`[InitialSync] ${nonMandatoryPending.length} non-mandatory deferred record(s) stay PENDING (background retry after READY heals them)`)
    }
  } catch (deferredPassErr) {
    console.warn('[InitialSync] Deferred retry pass error (non-fatal):', deferredPassErr.message)
  }

  // ── Step 3d (Task 43): empty-business-stage reconciliation ─────────────
  // The staged importer is proven healthy, but a live incident showed a
  // workspace going READY with 0 branches/services while the cloud's own
  // list endpoints still returned rows. Cross-check BOTH critical stages
  // against the canonical list endpoints and import directly on a gap —
  // and record the cloud counts so the integrity warnings below state
  // WHICH side is empty instead of a bare "No branches imported".
  let reconciliation = null
  try {
    reconciliation = await _reconcileEmptyBusinessStages(db, agencyId, cloudUrl, cloudAuthToken, effectiveSignal, emit)
    for (const [stageName, r] of Object.entries(reconciliation)) {
      if (r.cloudCheckError) {
        console.warn(`[InitialSync] Reconciliation ${stageName}: cloud check failed — ${r.cloudCheckError}`)
      } else if (r.localCount === 0 && r.cloudCount > 0 && r.reconciled > 0) {
        console.log(`[InitialSync] Reconciliation ${stageName}: HEALED — imported ${r.reconciled} row(s) after the stage came back empty`)
      }
    }
  } catch (reconErr) {
    console.warn('[InitialSync] Reconciliation step error (non-fatal):', reconErr.message)
  }

  // ── Step 4: Integrity validation ────────────────────────────────────────
  const validation = await _validateIntegrity(db, agencyId)
  if (!validation.valid) {
    console.warn('[InitialSync] Integrity issues:', validation.issues)

    // If any mandatory check fails → set status FAILED
    const mandatoryIssues = validation.issues.filter(i =>
      i.includes('missing') || i.includes('No services') || i.includes('No branches') || i.includes('No counters')
    )
    if (mandatoryIssues.length > 0) {
      await _updateLocalState(db, agencyId, {
        initializationStatus: 'FAILED',
        lastError: `Integrity validation failed: ${mandatoryIssues.join('; ')}`,
      })
      emit({ type: 'SYNC_ERROR', stage: 'validation', error: `Integrity failed: ${mandatoryIssues.join('; ')}`, retryable: false })
      _activeSync = null
      return {
        success: false,
        totalRecords,
        duration: Date.now() - startTime,
        error: `Integrity validation failed: ${mandatoryIssues.join('; ')}`,
      }
    }
  }
  // Empty collections (services/branches/counters) are EXPECTED on a freshly
  // wizard-created agency — surface them as warnings, never as failures.
  // Task 43: when a reconciled stage is STILL empty locally, the warning now
  // says what the cloud's canonical endpoint reported, so "no branches yet"
  // on the desktop always tells the user which side holds the data.
  if (validation.warnings && validation.warnings.length > 0) {
    const enriched = validation.warnings.map((w) => {
      if (reconciliation && w === 'No branches imported' && reconciliation.branches) {
        const r = reconciliation.branches
        if (r.cloudCount === 0) return 'No branches imported (the cloud also reports 0 branches for this agency — nothing to import; create branches here or in the webapp and re-login/sync)'
        if (r.cloudCount > 0 && r.reconciled > 0) return `No branches imported by the staged pass — ${r.reconciled} branch(es) recovered via reconciliation`
        if (r.cloudCount > 0) return `No branches imported (the cloud DOES report ${r.cloudCount} branch(es) — reconciliation could not import them; check the log)`
      }
      if (reconciliation && w === 'No services imported' && reconciliation.services) {
        const r = reconciliation.services
        if (r.cloudCount === 0) return 'No services imported (the cloud also reports 0 services for this agency — nothing to import; create services here or in the webapp and re-login/sync)'
        if (r.cloudCount > 0 && r.reconciled > 0) return `No services imported by the staged pass — ${r.reconciled} service(s) recovered via reconciliation`
        if (r.cloudCount > 0) return `No services imported (the cloud DOES report ${r.cloudCount} service(s) — reconciliation could not import them; check the log)`
      }
      return w
    })
    console.warn('[InitialSync] Integrity warnings (non-fatal):', enriched)
    emit({ type: 'SYNC_WARNING', stage: 'validation', message: `Non-fatal: ${enriched.join('; ')}` })
  }

  // ── Step 4b: Race condition check ─────────────────────────────────────
  // During initial sync, cloud data may have changed. We use upserts
  // (last-write-wins) so the data we imported is correct as of the snapshot
  // time. However, new changes may have occurred since the snapshot was taken.
  // Re-fetch the discovery endpoint to check if snapshotSequence has advanced.
  // If it has, log a warning — the incremental sync will catch the diff.
  try {
    const currentDiscovery = await _cloudPost(discoveryUrl, {
      agencyId,
      protocolVersion: SYNC_PROTOCOL_VERSION,
    }, cloudAuthToken, { signal: effectiveSignal })
    const currentSnapshotSeq = currentDiscovery?.snapshotSequence || 0
    if (currentSnapshotSeq > snapshotSequence) {
      console.warn(
        `[InitialSync] Race condition detected: snapshotSequence advanced from ${snapshotSequence} to ${currentSnapshotSeq} during import. ` +
        `The incremental sync will pull changes from sequence ${snapshotSequence} onwards.`
      )
      emit({
        type: 'SYNC_WARNING',
        stage: 'race-condition',
        message: `Snapshot sequence advanced from ${snapshotSequence} to ${currentSnapshotSeq} during import`,
        originalSequence: snapshotSequence,
        currentSequence: currentSnapshotSeq,
      })
    }
  } catch (e) {
    // Non-fatal: if we can't reach the discovery endpoint, we just skip this check.
    // The incremental sync will catch any missed changes regardless.
    console.warn('[InitialSync] Race condition check failed (non-fatal):', e.message)
  }

  // ── Step 4c (Part AE): snapshot bridge — apply changes > S before READY ─
  // Do NOT mark READY before this bridge completes: the gap between the
  // snapshot and "now" must be closed while the state is still INITIALIZING.
  let bridgeFinalSequence = snapshotSequence
  try {
    const bridge = await _bridgeChangesSinceSnapshot(
      db, agencyId, cloudUrl, cloudAuthToken, snapshotSequence, effectiveSignal, emit,
    )
    bridgeFinalSequence = bridge.finalSequence
    // CURSOR INVARIANT receipt (field round 6): the log must state the full
    // chain — snapshot S → bridge pages → final F — and F means "every change
    // ≤ F is durably ledger-accounted", not a value that jumped ahead.
    console.log(`[InitialSync] Snapshot bridge complete: ${bridge.applied} change(s) applied across ${bridge.pages} page(s) — cursor invariant: snapshot=${snapshotSequence} → bridge final=${bridgeFinalSequence}${bridgeFinalSequence >= snapshotSequence ? ' (every change ≤ ' + bridgeFinalSequence + ' accounted via the apply ledger)' : ' — INVALID: bridge final < snapshot (feed went backward)'}`)
  } catch (bridgeErr) {
    await _updateLocalState(db, agencyId, {
      initializationStatus: 'FAILED',
      lastError: `Snapshot bridge failed: ${bridgeErr.message}`,
    })
    emit({ type: 'SYNC_ERROR', stage: 'snapshot-bridge', error: bridgeErr.message, retryable: true })
    _activeSync = null
    return {
      success: false,
      totalRecords,
      duration: Date.now() - startTime,
      error: `Snapshot bridge failed: ${bridgeErr.message}`,
    }
  }

  // ── Step 4d (P0-3): FINAL deferred gate over ALL sources, post-bridge ───
  // The bridge applies pull pages through the engine, which durably defers
  // FK-blocked rows with source='pull'. READY must never be declared while
  // such rows are unaccounted for (review Problem 7). Mandatory-model rows
  // that remain unresolvable after the bridge are QUARANTINED with a visible
  // reason (the feed is exhausted — their parents will not arrive); the
  // integrity validation already failed READY if a core table ended empty.
  try {
    const postBridgePending = await db.$queryRawUnsafe(
      "SELECT id, model, recordId, source FROM _deferred_changes WHERE agencyId = ? AND status = 'PENDING'", agencyId
    ).catch(() => [])
    const rows = postBridgePending || []
    const mandatoryRows = rows.filter((r) => MANDATORY_READY_MODELS.has(r.model))
    if (mandatoryRows.length > 0) {
      for (const row of mandatoryRows) {
        await db.$executeRawUnsafe(
          "UPDATE _deferred_changes SET status = 'QUARANTINED', lastError = ? WHERE id = ?",
          `unresolvable at init: bridge exhausted feed to seq ${bridgeFinalSequence}; parents not delivered by cloud`, row.id
        ).catch(() => {})
      }
      deferredOutcome.quarantinedAtGate += mandatoryRows.length
      console.warn(`[InitialSync] Post-bridge gate: ${mandatoryRows.length} mandatory-model deferred row(s) quarantined (${mandatoryRows.map(r => r.model + '/' + r.recordId).join(', ')})`)
      emit({ type: 'SYNC_WARNING', stage: 'snapshot-bridge', message: `${mandatoryRows.length} mandatory deferred record(s) quarantined after bridge` })
    }
    deferredOutcome.pendingInitialSync = rows.filter((r) => r.source === 'initial-sync' && !MANDATORY_READY_MODELS.has(r.model)).length
    deferredOutcome.pendingPull = rows.filter((r) => r.source !== 'initial-sync' && !MANDATORY_READY_MODELS.has(r.model)).length
  } catch (gateErr) {
    console.warn('[InitialSync] Post-bridge deferred gate error (non-fatal):', gateErr.message)
  }

  // ── Step 5: Mark READY (with a recorded integrity receipt) ──────────────
  const completedAt = new Date()
  const readyChecks = {
    agencyRow: 'checked-by-integrity-validation',
    servicesBranches: 'checked-by-integrity-validation',
    deferredPendingInitialSync: deferredOutcome.pendingInitialSync,
    deferredPendingPull: deferredOutcome.pendingPull,
    deferredQuarantinedAtGate: deferredOutcome.quarantinedAtGate,
    snapshotSequence,
    bridgeFinalSequence,
    bridgeCoversSnapshot: bridgeFinalSequence >= snapshotSequence,
    readyAt: completedAt.toISOString(),
  }
  await _setMeta(db, `readyChecks:${agencyId}`, JSON.stringify(readyChecks))

  // ── Step 4e: adopt the engine cursor BEFORE the READY flip ─────────────
  // The Part D gate unblocks incremental pulls the instant READY is set, so
  // the cursor must already be correct here — a stale pre-import value (e.g.
  // 893 from an older build) must never decide where the first post-READY
  // pull starts (field round 6: bridge final 890 was shadowed by a stale
  // v2 cursor key and the engine pulled from 893, skipping 891..893 of the
  // import baseline).
  // Write BOTH engine keys (the v2 key `lastPulledSequence` AND the legacy
  // `_lastPulledSequence`) so no reader can be shadowed by stale history,
  // then adopt through the RUNNING engine (in-memory _cursor + audit row).
  await _setMeta(db, `lastPulledSequence`, String(bridgeFinalSequence))
  await _setMeta(db, `_lastPulledSequence`, String(bridgeFinalSequence))
  try {
    const syncServiceForCursor = require('./sync-service') // lazy — avoids the module cycle
    await syncServiceForCursor.setInitialCursor(bridgeFinalSequence, {
      source: 'initial-sync-bridge',
      snapshotSequence,
      bridgeFinalSequence,
    })
  } catch (cursorAdoptErr) {
    // Engine not started in this process (e.g. HTTP-path import): the
    // persisted keys above are authoritative and startSync hydrates them.
    console.log('[InitialSync] Engine cursor adoption skipped (engine not running here): ' + cursorAdoptErr.message)
  }

  await _updateLocalState(db, agencyId, {
    initializationStatus: 'READY',
    initializationCompletedAt: completedAt,
    currentStage: null,
    currentCursor: null,
    lastError: null,
  })

  // ── Step 6: Bridge to incremental sync (bookkeeping) ──────────────────
  // The ENGINE CURSOR (lastPulledSequence + legacy _lastPulledSequence) was
  // already adopted to bridgeFinalSequence in Step 4e BEFORE the READY flip.
  // Here we only record the audit keys.
  // Part E/AE: the engine cursor equals the bridge's final page sequence —
  // every change after the ORIGINAL snapshot has already been applied by the
  // bridge, so nothing between S and now can be missed. The original S stays
  // recorded as initialSyncSnapshotSequence (audit + retention checks).
  await _setMeta(db, `initialSyncSnapshotSequence`, String(snapshotSequence))
  await _setMeta(db, `agencyInitialized:${agencyId}`, 'true')
  await _setMeta(db, `initialSyncCompletedAt:${agencyId}`, String(completedAt.getTime()))

  const duration = completedAt.getTime() - startTime

  // Emit completion
  emit({
    type: 'SYNC_COMPLETED',
    agencyId,
    syncId,
    totalRecords,
    duration,
    snapshotSequence,
    bridgeFinalSequence,
    validation,
    readyChecks,
  })

  _activeSync = null

  return {
    success: true,
    totalRecords,
    duration,
    syncId,
    snapshotSequence,
    bridgeFinalSequence,
    readyChecks,
  }
}

/**
 * Abort an active initial sync.
 */
function abortInitialSync() {
  if (_activeSync?.abortController) {
    _activeSync.abortController.abort()
    _activeSync = null
    return true
  }
  return false
}

/**
 * Get the current active sync state.
 * Task 46: enriched with live stage/progress info from _lastProgress so the
 * post-login loading gate can render stage names and counts.
 */
function getActiveSyncStatus() {
  if (!_activeSync) return null
  const p = _lastProgress && _lastProgress.agencyId === _activeSync.agencyId ? _lastProgress : null
  return {
    syncId: _activeSync.syncId,
    agencyId: _activeSync.agencyId,
    active: true,
    startedAt: _activeSync.startedAt,
    stage: p?.stage || null,
    stageIndex: p?.stageIndex ?? null,
    totalStages: p?.totalStages ?? null,
    recordsImported: p?.count ?? null,
    lastEventType: p?.type || null,
    lastEventAt: p?.at || null,
  }
}

/**
 * Task 46: one-call snapshot of the initial-sync engine for the status and
 * diagnostics endpoints — active run, live progress, and the [SyncDiag]
 * ring buffer (last entries first for easy reading).
 */
function getInitialSyncSnapshot() {
  return {
    active: !!_activeSync,
    activeSync: _activeSync
      ? {
          syncId: _activeSync.syncId,
          agencyId: _activeSync.agencyId,
          startedAt: _activeSync.startedAt,
          stage: (_lastProgress && _lastProgress.agencyId === _activeSync.agencyId && _lastProgress.stage) || null,
        }
      : null,
    lastProgress: _lastProgress,
    diag: _diagLog.slice(-80).reverse(),
  }
}

/**
 * Reset the initial sync state for an agency (allows re-import).
 * USE WITH CAUTION — this clears the initialized flag.
 * Now uses AgencyLocalState instead of _sync_meta.
 */
async function resetInitialSync(db, agencyId) {
  if (!db) return

  await _ensureMetaTable(db)

  // Reset AgencyLocalState
  await _updateLocalState(db, agencyId, {
    initializationStatus: 'NOT_INITIALIZED',
    initializationSessionId: null,
    initializationStartedAt: null,
    initializationCompletedAt: null,
    currentStage: null,
    currentCursor: null,
    recordsImported: 0,
    lastError: null,
    snapshotSequence: 0,
  })

  // Also clear _sync_meta entries for backward compatibility
  await _setMeta(db, `agencyInitialized:${agencyId}`, 'false')
  await _setMeta(db, `initialSyncCompletedAt:${agencyId}`, '')

  console.log('[InitialSync] Reset initial sync state for agency:', agencyId)
}

/**
 * Check if an agency is ready (initialization complete).
 * Used by sync-service.js to gate incremental sync.
 */
async function isAgencyReady(db, agencyId) {
  if (!db || !agencyId) return false
  try {
    const state = await db.agencyLocalState.findUnique({
      where: { agencyId },
      select: { initializationStatus: true },
    })
    return state?.initializationStatus === 'READY'
  } catch {
    return false
  }
}

// ─── Module Exports ────────────────────────────────────────────────────────

module.exports = {
  runInitialSync,
  checkInitialSyncStatus,
  abortInitialSync,
  getActiveSyncStatus,
  // Task 46: live snapshot (active run + last progress + [SyncDiag] ring)
  // consumed by GET /api/sync/initial-sync/status and /api/sync/diagnostics.
  getInitialSyncSnapshot,
  resetInitialSync,
  isAgencyReady,
  // Task 43: exported for diagnostics/repair tooling — heals a workspace
  // whose staged import delivered 0 branches/services while the cloud's
  // canonical list endpoints still return rows.
  reconcileEmptyBusinessStages: _reconcileEmptyBusinessStages,
  // Task 46: exported for E2E harnesses/diagnostics — the REAL batch import
  // path (transform → sanitize → upsert → FK deferral) without a cloud.
  upsertBatch: _upsertBatch,
  SYNC_PROTOCOL_VERSION,
}
