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

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 500
const MAX_BACKOFF_MS = 30_000
const INITIAL_BACKOFF_MS = 1_000
const MAX_RETRIES_PER_REQUEST = 5
const SYNC_PROTOCOL_VERSION = 2

/**
 * Stage-to-model mapping for upsert routing.
 * The Cloud API returns stage names; we map them to Prisma model names.
 */
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
}

// ─── Module State ───────────────────────────────────────────────────────────

let _activeSync = null  // { syncId, agencyId, cloudUrl, authToken, db, emitFn, abortController }

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
async function _cloudPost(url, body, authToken, options = {}) {
  const { signal } = options
  let backoff = INITIAL_BACKOFF_MS
  let lastError = null

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

        // 5xx or other — retry
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
 * - Add syncVersion and syncedAt
 */
function _transformRecord(record) {
  const result = {}
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue
    if (DATE_FIELDS.has(key) && typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T/)) {
      result[key] = new Date(value)
    } else {
      result[key] = value
    }
  }
  // D6 fix (Task 3-b): do NOT inflate syncVersion. The cloud sends its own
  // syncVersion per record and the incremental-sync conflict detector compares
  // stored vs cloud values — storing cloud+1 made EVERY later cloud update
  // look like a conflict (unbounded _sync_conflicts growth, all 'pending').
  result.syncVersion = result.syncVersion || 0
  result.syncedAt = new Date()
  return result
}

// ─── Model-Specific Upsert Logic ────────────────────────────────────────────

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
  const record = _transformRecord(rawRecord)
  const id = record.id
  if (!id) return null

  const uniqueFields = MODEL_UNIQUE_KEYS[modelName] || ['id']
  const where = {}
  for (const field of uniqueFields) {
    where[field] = record[field]
  }

  // For create, include all fields
  const create = { ...record }

  // For update, exclude immutable fields and the unique key fields
  const update = {}
  for (const [key, value] of Object.entries(record)) {
    if (MODEL_IMMUTABLE_FIELDS.has(key)) continue
    if (uniqueFields.includes(key)) continue
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
    // If upsert fails due to missing relation, log and skip
    console.warn(`[InitialSync] Upsert failed for ${modelName}/${rawRecord.id}: ${e.message}`)
    return false
  }
}

/**
 * Fallback raw SQL upsert for models not in the Prisma client.
 */
async function _upsertRecordRaw(tx, modelName, rawRecord) {
  const record = _transformRecord(rawRecord)
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
async function _upsertBatch(db, modelName, records) {
  if (!records || records.length === 0) return 0

  let upserted = 0
  await db.$transaction(async (tx) => {
    for (const rawRecord of records) {
      const success = await _upsertRecord(tx, modelName, rawRecord)
      if (success) upserted++
    }
  }, { maxWait: 5000, timeout: 30000 })

  return upserted
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
 * Mandatory checks: agency exists, services/branches/counters have records.
 * Foreign key checks: counters→branches, agencyStaff→users.
 */
async function _validateIntegrity(db, agencyId) {
  const issues = []

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

  // 2. Services must exist (mandatory)
  try {
    const svcCount = await db.service.count({ where: { agencyId } })
    if (svcCount === 0) issues.push('No services imported')
  } catch {
    try {
      const svcCount = await db.$queryRawUnsafe(
        'SELECT COUNT(*) as cnt FROM "Service" WHERE agencyId = ?', agencyId
      )
      const count = typeof svcCount?.[0]?.cnt === 'bigint' ? Number(svcCount[0].cnt) : (svcCount?.[0]?.cnt || 0)
      if (count === 0) issues.push('No services imported')
    } catch { /* Service table may not exist yet */ }
  }

  // 3. Branches must exist (mandatory)
  try {
    const branchCount = await db.branch.count({ where: { agencyId } })
    if (branchCount === 0) issues.push('No branches imported')
  } catch {
    try {
      const branchCount = await db.$queryRawUnsafe(
        'SELECT COUNT(*) as cnt FROM "Branch" WHERE agencyId = ?', agencyId
      )
      const count = typeof branchCount?.[0]?.cnt === 'bigint' ? Number(branchCount[0].cnt) : (branchCount?.[0]?.cnt || 0)
      if (count === 0) issues.push('No branches imported')
    } catch { /* Branch table may not exist yet */ }
  }

  // 4. Counters must exist (mandatory)
  try {
    // Counters are linked via branches
    const branches = await db.branch.findMany({ where: { agencyId }, select: { id: true } })
    if (branches.length > 0) {
      const counterCount = await db.counter.count({
        where: { branchId: { in: branches.map(b => b.id) } },
      })
      if (counterCount === 0) issues.push('No counters imported')
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

  // Concurrency guard: prevent two initial syncs from running simultaneously.
  // If a sync is already active, abort it first before starting a new one.
  if (_activeSync) {
    console.warn('[InitialSync] Another initial sync is already running (syncId: %s, agencyId: %s) — aborting it before starting new sync',
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
  }

  const emit = _activeSync.emitFn
  const effectiveSignal = signal || _activeSync.abortController.signal

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

  const cloudStages = discoveryResult.stages
  const snapshotSequence = discoveryResult.snapshotSequence || 0

  // ── Step 2: Transition to INITIALIZING ──────────────────────────────────
  // Check for resumable state
  const resumeFromStage = localState.initializationStatus === 'INITIALIZING' ? localState.currentStage : null
  const resumeCursor = localState.initializationStatus === 'INITIALIZING' ? localState.currentCursor : null

  await _updateLocalState(db, agencyId, {
    initializationStatus: 'INITIALIZING',
    initializationSessionId: syncId,
    initializationStartedAt: localState.initializationStartedAt || new Date(),
    currentStage: resumeFromStage || cloudStages[0]?.id || null,
    currentCursor: resumeCursor,
    snapshotSequence,
    syncProtocolVersion: SYNC_PROTOCOL_VERSION,
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
      currentCursor: isResumeStage ? resumeCursor : null,
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
        const response = await _cloudPost(discoveryUrl, {
          agencyId,
          stage: stage.id,
          cursor,
          pageSize: PAGE_SIZE,
          protocolVersion: SYNC_PROTOCOL_VERSION,
        }, cloudAuthToken, { signal: effectiveSignal })

        if (!response?.success) {
          throw new Error(response?.error || `Stage ${stage.id} fetch failed`)
        }

        const records = response.records || []
        const nextCursor = response.nextCursor || null
        hasMore = response.hasMore === true

        if (records.length === 0 && !hasMore) {
          break
        }

        // If records is empty but hasMore was true, correct it
        if (records.length === 0) {
          hasMore = false
          break
        }

        // Upsert batch in transaction
        batchNumber++
        const upserted = await _upsertBatch(db, modelName, records)
        stageCount += upserted
        totalRecords += upserted

        // Advance cursor and update progress
        cursor = nextCursor
        await _updateLocalState(db, agencyId, {
          currentCursor: cursor,
          currentBatch: batchNumber,
          recordsImported: totalRecords,
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
        currentCursor: null,
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

  // ── Step 5: Mark READY ──────────────────────────────────────────────────
  const completedAt = new Date()
  await _updateLocalState(db, agencyId, {
    initializationStatus: 'READY',
    initializationCompletedAt: completedAt,
    currentStage: null,
    currentCursor: null,
    lastError: null,
  })

  // ── Step 6: Bridge to incremental sync ─────────────────────────────────
  // Store snapshotSequence in _sync_meta as _lastPulledSequence
  // so the incremental sync engine starts from the correct baseline.
  // Also store as initialSyncSnapshotSequence for clear identification of
  // the initial sync baseline (distinct from the advancing _lastPulledSequence).
  await _setMeta(db, `_lastPulledSequence`, String(snapshotSequence))
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
    validation,
  })

  _activeSync = null

  return {
    success: true,
    totalRecords,
    duration,
    syncId,
    snapshotSequence,
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
 */
function getActiveSyncStatus() {
  if (!_activeSync) return null
  return {
    syncId: _activeSync.syncId,
    agencyId: _activeSync.agencyId,
    active: true,
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
    currentBatch: 0,
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
  resetInitialSync,
  isAgencyReady,
  SYNC_PROTOCOL_VERSION,
}
