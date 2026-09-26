/**
 * BLASTI Initial Sync Route — Full Agency Data Snapshot
 *
 * Provides a single, paginated endpoint for first-time login sync.
 * Instead of hitting 8+ individual endpoints (which may 404), the client
 * calls this endpoint once per stage to receive all agency data in a
 * controlled, paginated format.
 *
 * POST /api/sync/initial-data
 *
 * Stages (in dependency order):
 *   1. agency          — Single agency record
 *   2. users           — Users associated with this agency (via AgencyStaff)
 *   3. services        — Services for this agency
 *   4. branches        — Branches for this agency
 *   5. counters        — Counters for this agency (via branches)
 *   6. agencyStaff     — AgencyStaff records for this agency
 *   7. queueSettings   — QueueSettings for this agency
 *   8. smsSettings     — Platform SMS settings singleton (Task 4-b §5-5; global
 *                        singleton — projection mirrors the incremental pull in
 *                        sync.ts and EXCLUDES the apiKey credential/templates)
 *   9. paymentSettings — Platform payment settings singleton (Task 4-b §5-5;
 *                        global singleton — cloud already serves this PUBLICLY
 *                        via GET /api/payment-settings, projection mirrors sync.ts)
 *  10. reservations    — Reservations for this agency (paginated, the big one)
 *  11. reviews         — Reviews for this agency
 *  12. favorites       — Favorites for this agency (agencyId-scoped, paginated)
 *  13. faqs            — FAQ content (global read-only content, Task 4-b §5-5)
 *  14. notifications   — Notifications for agency users
 *  15. announcements   — Announcements for this agency
 *  16. globalAnnouncements — Platform-wide broadcast announcements (global,
 *                        read-only; no agency scoping exists by design)
 *  17. transactions    — Transactions for this agency
 *  18. subscriptionPlans — Active subscription plans (global, not agency-scoped)
 *  19. planFeatures    — Feature flags of active plans (scoped via plan relation;
 *                        global plan metadata like subscriptionPlans)
 */

import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, requireAgencyAccess, authErrorResponse, AuthError } from '../lib/auth'
import { getLatestSequence, redactRecord, projectUserSyncDto } from '../lib/sync-helpers'
import { SYNC_PROTOCOL_VERSION, SYNC_REGISTRY } from '@blasti/core/sync-registry'
import { serializeForCloud } from '@blasti/core/sync-serializer'
import { z } from 'zod'

const app = new Hono()

// ─── Request / Response Types ────────────────────────────────────────────────

const initialSyncRequestSchema = z.object({
  agencyId: z.string().min(1),
  stage: z.string().optional(),
  cursor: z.string().optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
  protocolVersion: z.number().optional(),
  // Part E: the client pins the snapshot ONCE at discovery and echoes it on
  // every stage/page request — the server must NOT recompute it per page
  // (a later value would silently widen the snapshot mid-import).
  snapshotSequence: z.number().int().min(0).optional(),
})

interface StageMeta {
  id: string
  label: string
  mandatory: boolean
  estimatedCount?: number
}

interface InitialSyncResponse {
  success: boolean
  protocolVersion: number
  snapshotSequence: number
  stage: string
  records: any[]
  nextCursor?: string
  hasMore: boolean
  count: number
  total?: number
  stages: StageMeta[]
}

// ─── Stage Definitions ───────────────────────────────────────────────────────

// Stage order is FK-SAFE (dependency order): importers apply stages in wire
// order and SQLite enforces foreign keys, so every referenced model must be
// imported BEFORE the models that reference it (User before Agency.ownerId,
// SubscriptionPlan before Agency.subscriptionPlanId, Branch/Service before
// Counter, ... ). Mirrors packages/core/sync-registry.json syncOrder.
const STAGE_DEFINITIONS: StageMeta[] = [
  { id: 'users', label: 'Users', mandatory: true  },
  { id: 'subscriptionPlans', label: 'Subscription Plans', mandatory: false },
  { id: 'planFeatures', label: 'Plan Features', mandatory: false },
  { id: 'agency', label: 'Agency', mandatory: true  },
  { id: 'branches', label: 'Branches', mandatory: true  },
  { id: 'services', label: 'Services', mandatory: true  },
  { id: 'agencyStaff', label: 'Agency Staff', mandatory: true  },
  { id: 'counters', label: 'Counters', mandatory: true  },
  { id: 'queueSettings', label: 'Queue Settings', mandatory: true  },
  { id: 'reservations', label: 'Reservations', mandatory: true  },
  { id: 'transactions', label: 'Transactions', mandatory: false },
  { id: 'smsSettings', label: 'SMS Settings', mandatory: false },
  { id: 'paymentSettings', label: 'Payment Settings', mandatory: false },
  { id: 'notifications', label: 'Notifications', mandatory: false },
  { id: 'announcements', label: 'Announcements', mandatory: false },
  { id: 'globalAnnouncements', label: 'Global Announcements', mandatory: false },
  { id: 'reviews', label: 'Reviews', mandatory: false },
  { id: 'favorites', label: 'Favorites', mandatory: false },
  { id: 'faqs', label: 'FAQs', mandatory: false },
  { id: 'agencyCategories', label: 'Agency Categories', mandatory: false },
]

const VALID_STAGES = new Set(STAGE_DEFINITIONS.map((s) => s.id))

// Stages that support cursor-based pagination (large data sets)
const PAGINATED_STAGES = new Set([
  'reservations',
  'notifications',
  'reviews',
  'transactions',
  'favorites', // grows with the agency's user base — paginate like reviews
])

const DEFAULT_PAGE_SIZE = 500
const MAX_PAGE_SIZE = 1000

// ─── Sync Registry Lookup ────────────────────────────────────────────────────

function findSyncConfig(model: string) {
  return SYNC_REGISTRY.find((c) => c.model === model && c.isSynced)
}

// ─── Data Fetchers Per Stage ─────────────────────────────────────────────────

/**
 * Fetch data for a given stage. Returns records and total count.
 * Uses cursor-based pagination for large stages.
 */
async function fetchStageData(
  stage: string,
  agencyId: string,
  cursor: string | undefined,
  pageSize: number,
): Promise<{ records: any[]; nextCursor?: string; hasMore: boolean; total?: number }> {
  switch (stage) {
    // ── 1. Agency ─────────────────────────────────────────────────────────
    case 'agency': {
      const record = await db.agency.findUnique({
        where: { id: agencyId },
      })
      const records = record ? [record] : []
      return { records, hasMore: false, total: records.length }
    }

    // ── 2. Users ──────────────────────────────────────────────────────────
    case 'users': {
      // Get user IDs from AgencyStaff, plus the agency owner, plus every
      // user referenced by synced agency data (Reservation.userId for
      // customer tickets, Review/Favorite authors). Importing ONLY staff
      // left reservations pointing at users the desktop had never stored —
      // the local SQLite FK constraint then rejected those reservations.
      const [staffRecords, agency, reservationUsers, reviewUsers, favoriteUsers] = await Promise.all([
        db.agencyStaff.findMany({ where: { agencyId, isActive: true }, select: { userId: true } }),
        db.agency.findUnique({ where: { id: agencyId }, select: { ownerId: true } }),
        db.reservation.findMany({ where: { agencyId }, select: { userId: true }, distinct: ['userId'] }),
        db.review.findMany({ where: { agencyId }, select: { userId: true }, distinct: ['userId'] }),
        db.favorite.findMany({ where: { agencyId }, select: { userId: true }, distinct: ['userId'] }),
      ])
      const userIds = new Set<string>(staffRecords.map((s: any) => s.userId))
      if (agency?.ownerId) userIds.add(agency.ownerId)
      for (const r of reservationUsers) if (r.userId) userIds.add(r.userId)
      for (const r of reviewUsers) if (r.userId) userIds.add(r.userId)
      for (const r of favoriteUsers) if (r.userId) userIds.add(r.userId)

      if (userIds.size === 0) {
        return { records: [], hasMore: false, total: 0 }
      }

      const records = await db.user.findMany({
        where: { id: { in: Array.from(userIds) } },
        
      })
      // Task 14 — explicit USER_SYNC allow-list projection: ONLY the listed
      // profile fields are ever serialized (passwordHash / fcmToken and any
      // future auth secret are excluded BY CONSTRUCTION, not by redaction).
      // redactRecord stays as a redundant final safety net (Part AF).
      return {
        records: records.map((r: any) => redactRecord('User', projectUserSyncDto(r))),
        hasMore: false,
        total: records.length,
      }
    }

    // ── 3. Services ───────────────────────────────────────────────────────
    case 'services': {
      const records = await db.service.findMany({
        where: { agencyId },
        
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 4. Branches ───────────────────────────────────────────────────────
    case 'branches': {
      const records = await db.branch.findMany({
        where: { agencyId },
        
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 5. Counters ───────────────────────────────────────────────────────
    case 'counters': {
      // Get counters via branches belonging to this agency
      const branchIds = await db.branch.findMany({
        where: { agencyId },
        select: { id: true },
      })
      if (branchIds.length === 0) {
        return { records: [], hasMore: false, total: 0 }
      }
      const records = await db.counter.findMany({
        where: { branchId: { in: branchIds.map((b: any) => b.id) } },
        
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 6. AgencyStaff ────────────────────────────────────────────────────
    case 'agencyStaff': {
      const records = await db.agencyStaff.findMany({
        where: { agencyId },
        
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 7. QueueSettings ──────────────────────────────────────────────────
    case 'queueSettings': {
      const records = await db.queueSettings.findMany({
        where: { agencyId },
        orderBy: { updatedAt: 'desc' },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 7b. SmsSettings (Task 4-b §5-5) ───────────────────────────────
    case 'smsSettings': {
      // SECURITY: global platform singleton — no agency scoping exists in the
      // schema (documented decision). The projection mirrors the incremental
      // pull (sync.ts fetchRecordsForModel 'SmsSettings') and deliberately
      // EXCLUDES the apiKey credential and message templates.
      const records = await db.smsSettings.findMany({
        select: {
          id: true, provider: true, apiUrl: true, senderName: true,
          enabled: true, smsPerReminder: true, maxSmsPerDay: true,
          testPhoneNumber: true, 
          createdAt: true, updatedAt: true,
        },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 7c. PaymentSettings (Task 4-b §5-5) ───────────────────────────
    case 'paymentSettings': {
      // SECURITY: global platform singleton. Cloud already serves this model
      // PUBLICLY (unauthenticated GET /api/payment-settings) so agencies can
      // read bank transfer instructions — projection mirrors the incremental
      // pull (sync.ts 'PaymentSettings'), no new exposure.
      const records = await db.paymentSettings.findMany({
        select: {
          id: true, ccpEnabled: true, bankEnabled: true, electronicEnabled: true,
          ccpAccount: true, ccpKey: true, bankName: true, bankAccount: true,
          bankRib: true, ewalletNumber: true, 
          createdAt: true, updatedAt: true,
        },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 8. Reservations (paginated) ───────────────────────────────────────
    case 'reservations': {
      return fetchPaginated(
        () => db.reservation.count({ where: { agencyId } }),
        () =>
          db.reservation.findMany({
            where: {
              agencyId,
              ...tupleKeyset('joinedAt', parseStageCursor(cursor)),
            },
            // NOTE: Reservation has no createdAt — the queue timestamp is joinedAt.
            orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
            take: pageSize + 1,
          }),
        pageSize,
        'joinedAt',
      )
    }

    // ── 9. Reviews (paginated) ────────────────────────────────────────────
    case 'reviews': {
      return fetchPaginated(
        () => db.review.count({ where: { agencyId } }),
        () =>
          db.review.findMany({
            where: {
              agencyId,
              ...tupleKeyset('createdAt', parseStageCursor(cursor)),
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: pageSize + 1,
          }),
        pageSize,
        'createdAt',
      )
    }

    // ── 9b. Favorites (paginated, agencyId-scoped — Task 4-b §5-5) ────
    case 'favorites': {
      return fetchPaginated(
        () => db.favorite.count({ where: { agencyId } }),
        () =>
          db.favorite.findMany({
            where: {
              agencyId,
              ...tupleKeyset('createdAt', parseStageCursor(cursor)),
            },
            select: {
              id: true, userId: true, agencyId: true, 
              createdAt: true, updatedAt: true,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: pageSize + 1,
          }),
        pageSize,
        'createdAt',
      )
    }

    // ── 9c. FAQs (global read-only content — Task 4-b §5-5) ──────────
    case 'faqs': {
      // Global content model (no agency scoping in schema — documented).
      // No isActive filter: mirrors the incremental pull so locally
      // deactivated FAQs keep their state instead of being resurrected.
      const records = await db.fAQ.findMany({
        select: {
          id: true, question: true, questionFr: true, questionAr: true,
          answer: true, answerFr: true, answerAr: true,
          category: true, order: true, isActive: true,
           createdAt: true, updatedAt: true,
        },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 9d. Agency Categories (Task 42-a: shared custom-fields dictionary) ──
    case 'agencyCategories': {
      // Global dictionary model (no agency scoping) — every agency's desktop
      // receives ALL user-created categories so any owner can select them.
      const records = await db.agencyCategory.findMany({
        select: {
          id: true, name: true, nameFr: true, nameAr: true, icon: true,
          isCustom: true, createdBy: true, createdAt: true, updatedAt: true,
        },
        orderBy: [{ createdAt: 'asc' }],
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 10. Notifications (paginated) ─────────────────────────────────────
    case 'notifications': {
      // Get user IDs for this agency to filter notifications
      const staffRecords = await db.agencyStaff.findMany({
        where: { agencyId, isActive: true },
        select: { userId: true },
      })
      const agency = await db.agency.findUnique({
        where: { id: agencyId },
        select: { ownerId: true },
      })
      const userIds = new Set(staffRecords.map((s: any) => s.userId))
      if (agency?.ownerId) userIds.add(agency.ownerId)

      if (userIds.size === 0) {
        return { records: [], hasMore: false, total: 0 }
      }

      const userIdArray = Array.from(userIds)
      return fetchPaginated(
        () => db.notification.count({ where: { userId: { in: userIdArray } } }),
        () =>
          db.notification.findMany({
            where: {
              userId: { in: userIdArray },
              ...tupleKeyset('createdAt', parseStageCursor(cursor)),
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: pageSize + 1,
          }),
        pageSize,
        'createdAt',
      )
    }

    // ── 11. Announcements ─────────────────────────────────────────────────
    case 'announcements': {
      const records = await db.announcement.findMany({
        where: { agencyId },
        
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 11b. GlobalAnnouncements (global broadcast content — Task 4-b §5-5)
    case 'globalAnnouncements': {
      // SECURITY: platform-wide broadcast announcements — global by design
      // (meant for every agency/user; no agency scoping exists). Projection
      // mirrors the incremental pull (sync.ts 'GlobalAnnouncement').
      const records = await db.globalAnnouncement.findMany({
        select: {
          id: true, message: true, type: true, createdBy: true,
           createdAt: true, updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 12. Transactions (paginated) ──────────────────────────────────────
    case 'transactions': {
      return fetchPaginated(
        () => db.transaction.count({ where: { agencyId } }),
        () =>
          db.transaction.findMany({
            where: {
              agencyId,
              ...tupleKeyset('createdAt', parseStageCursor(cursor)),
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: pageSize + 1,
          }),
        pageSize,
        'createdAt',
      )
    }

    // ── 13. SubscriptionPlans (global, not agency-scoped) ─────────────────
    case 'subscriptionPlans': {
      const records = await db.subscriptionPlan.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 13b. PlanFeatures of ACTIVE plans (Task 4-b §5-5) ─────────────
    case 'planFeatures': {
      // Scoped through the plan relation (no direct agencyId on the model):
      // only features of ACTIVE plans, mirroring the subscriptionPlans stage
      // scope. Global plan metadata — same exposure class as plans themselves.
      const records = await db.planFeature.findMany({
        where: { plan: { isActive: true } },
        select: {
          id: true, planId: true, featureKey: true,
          featureName: true, featureNameAr: true, featureNameFr: true,
          enabled: true, limitValue: true, 
          createdAt: true, updatedAt: true,
        },
        
      })
      return { records, hasMore: false, total: records.length }
    }

    default:
      return { records: [], hasMore: false, total: 0 }
  }
}

// ─── Generic Paginated Fetcher ───────────────────────────────────────────────

/**
 * Generic cursor-based pagination using the "take N+1" pattern.
 * - Fetches `pageSize + 1` records to determine if there are more.
 * - Cursor is the last record's ID from the previous page.
 * - Returns the actual page of records + pagination metadata.
 */
interface StageCursorTuple {
  time: string
  id: string
}

/**
 * Deterministic keyset pagination (spec Part H, Option B - tuple cursor).
 *
 * The old pattern `ORDER BY [timeField, id]` + `WHERE id > cursor` was an
 * INVALID keyset: records with id <= cursor but a later sort key were skipped
 * permanently. The cursor is now the TUPLE `<timeISO>|<id>` and the WHERE
 * clause is the matching lexicographic condition:
 *
 *   timeField > t  OR  (timeField = t AND id > lastId)
 *
 * Legacy plain-id cursors (pre-tuple imports) parse as invalid -> the stage
 * restarts from page 1 - safe, because every stage application is an
 * idempotent upsert.
 */
function parseStageCursor(cursor: string | undefined): StageCursorTuple | null {
  if (!cursor) return null
  const sep = cursor.indexOf('|')
  if (sep <= 0 || sep === cursor.length - 1) {
    console.warn(`[initial-sync] legacy/invalid cursor ignored - stage restarts from page 1: "${cursor.substring(0, 64)}"`)
    return null
  }
  const time = cursor.substring(0, sep)
  const id = cursor.substring(sep + 1)
  if (Number.isNaN(new Date(time).getTime())) return null
  return { time, id }
}

/** Tuple keyset condition matching the ORDER BY [timeField, id]. */
function tupleKeyset(timeField: string, tuple: StageCursorTuple | null) {
  if (!tuple) return {}
  return {
    OR: [
      { [timeField]: { gt: tuple.time } },
      { [timeField]: tuple.time, id: { gt: tuple.id } },
    ],
  }
}

/** Tuple cursor for the last record of a page. */
function makeStageCursor(record: any, timeField: string): string | undefined {
  if (!record) return undefined
  const t = record[timeField]
  if (!t) return undefined
  const iso = t instanceof Date ? t.toISOString() : String(t)
  return `${iso}|${record.id}`
}

async function fetchPaginated(
  countFn: () => Promise<number>,
  findManyFn: () => Promise<any[]>,
  pageSize: number,
  timeField: string,
): Promise<{ records: any[]; nextCursor?: string; hasMore: boolean; total?: number }> {
  const [allRecords, total] = await Promise.all([findManyFn(), countFn()])

  const hasMore = allRecords.length > pageSize
  const records = hasMore ? allRecords.slice(0, pageSize) : allRecords
  const nextCursor = hasMore && records.length > 0 ? makeStageCursor(records[records.length - 1], timeField) : undefined

  return { records, nextCursor, hasMore, total }
}

// ─── Serialization Helper ────────────────────────────────────────────────────

/**
 * Serialize records for cloud transport using the sync-serializer.
 * Falls back to raw records if no sync config is found for the model.
 */
function serializeRecords(stage: string, records: any[]): any[] {
  // Map stage names to SYNC_REGISTRY model names
  const stageToModel: Record<string, string> = {
    agency: 'Agency',
    users: 'User',
    services: 'Service',
    branches: 'Branch',
    counters: 'Counter',
    agencyStaff: 'AgencyStaff',
    queueSettings: 'QueueSettings',
    reservations: 'Reservation',
    reviews: 'Review',
    notifications: 'Notification',
    announcements: 'Announcement',
    globalAnnouncements: 'GlobalAnnouncement',
    transactions: 'Transaction',
    subscriptionPlans: 'SubscriptionPlan',
    planFeatures: 'PlanFeature',
    favorites: 'Favorite',
    faqs: 'FAQ',
    smsSettings: 'SmsSettings',
    paymentSettings: 'PaymentSettings',
    agencyCategories: 'AgencyCategory',
  }

  const modelName = stageToModel[stage]
  if (!modelName) return records

  const config = findSyncConfig(modelName)
  if (!config) return records

  return records.map((r) => serializeForCloud(config, r))
}

// ─── POST /api/sync/initial-data ─────────────────────────────────────────────

app.post('/initial-data', async (c) => {
  try {
    // ── Parse & validate request ──────────────────────────────────────────
    const body = await c.req.json()
    const validation = initialSyncRequestSchema.safeParse(body)

    if (!validation.success) {
      return c.json(
        { success: false, error: 'Invalid request', details: validation.error.issues },
        400,
      )
    }

    const { agencyId, stage, cursor, pageSize: rawPageSize, protocolVersion: _pv, snapshotSequence: clientSnapshot } = validation.data
    const pageSize = Math.min(rawPageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    // -- Protocol negotiation (spec Part AM) -----------------------------
    if (_pv !== undefined && _pv > SYNC_PROTOCOL_VERSION) {
      return c.json({
        success: false,
        error: 'UPDATE_REQUIRED',
        detail: `Client protocol ${_pv} is newer than server protocol ${SYNC_PROTOCOL_VERSION} - update the server`,
        serverProtocolVersion: SYNC_PROTOCOL_VERSION,
      }, 400)
    }

    // ── Authenticate & authorize ──────────────────────────────────────────
    const user = await requireAgencyAccess(c, agencyId)

    // -- Snapshot sequence (spec Part E: ONE immutable snapshot) ---------
    // Discovery (no stage) allocates the snapshot. Stage/page requests ECHO
    // the client-pinned value so every page of one import shares a snapshot.
    const snapshotSequence = stage
      ? (clientSnapshot ?? (await getLatestSequence(agencyId)))
      : await getLatestSequence(agencyId)

    // ── Discovery mode: return stages list ────────────────────────────────
    if (!stage) {
      // Estimate counts for each stage (best-effort, non-blocking)
      const stagesWithCounts = await Promise.all(
        STAGE_DEFINITIONS.map(async (s) => {
          try {
            const count = await estimateStageCount(s.id, agencyId)
            return { ...s, estimatedCount: count }
          } catch {
            return s // Skip count on error
          }
        }),
      )

      return c.json({
        success: true,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        snapshotSequence,
        stage: '',
        records: [],
        hasMore: false,
        count: 0,
        stages: stagesWithCounts,
      } satisfies InitialSyncResponse)
    }

    // ── Validate stage ────────────────────────────────────────────────────
    if (!VALID_STAGES.has(stage)) {
      return c.json(
        {
          success: false,
          error: `Invalid stage: "${stage}". Valid stages: ${Array.from(VALID_STAGES).join(', ')}`,
        },
        400,
      )
    }

    // ── Validate cursor for non-paginated stages ──────────────────────────
    if (cursor && !PAGINATED_STAGES.has(stage)) {
      return c.json(
        {
          success: false,
          error: `Cursor pagination not supported for stage "${stage}". This stage returns all records in a single response.`,
        },
        400,
      )
    }

    // ── Fetch data for the requested stage ────────────────────────────────
    const { records: rawRecords, nextCursor, hasMore, total } = await fetchStageData(
      stage,
      agencyId,
      cursor,
      pageSize,
    )

    // ── Serialize records for cloud transport ─────────────────────────────
    const records = serializeRecords(stage, rawRecords)

    // ── Build response ────────────────────────────────────────────────────
    return c.json({
      success: true,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      snapshotSequence,
      stage,
      records,
      nextCursor,
      hasMore,
      count: records.length,
      total,
      stages: STAGE_DEFINITIONS,
    } satisfies InitialSyncResponse)
  } catch (error: unknown) {
    if (error instanceof AuthError) {
      const err = authErrorResponse(error)
      return c.json({ success: err.success, error: err.error }, err.status as any)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('[initial-sync] Error:', message)
    return c.json({ success: false, error: message }, 500)
  }
})

// ─── Estimate Stage Counts ───────────────────────────────────────────────────

/**
 * Best-effort count estimation for discovery mode.
 * Uses COUNT queries which are fast on PostgreSQL with indexes.
 */
async function estimateStageCount(stage: string, agencyId: string): Promise<number> {
  switch (stage) {
    case 'agency':
      return 1
    case 'users': {
      const [staffCount, agency] = await Promise.all([
        db.agencyStaff.count({ where: { agencyId, isActive: true } }),
        db.agency.findUnique({ where: { id: agencyId }, select: { ownerId: true } }),
      ])
      return staffCount + (agency?.ownerId ? 1 : 0)
    }
    case 'services':
      return db.service.count({ where: { agencyId } })
    case 'branches':
      return db.branch.count({ where: { agencyId } })
    case 'counters': {
      const branchIds = await db.branch.findMany({
        where: { agencyId },
        select: { id: true },
      })
      return db.counter.count({
        where: { branchId: { in: branchIds.map((b: any) => b.id) } },
      })
    }
    case 'agencyStaff':
      return db.agencyStaff.count({ where: { agencyId } })
    case 'queueSettings':
      return db.queueSettings.count({ where: { agencyId } })
    case 'reservations':
      return db.reservation.count({ where: { agencyId } })
    case 'reviews':
      return db.review.count({ where: { agencyId } })
    case 'notifications': {
      const [staffRecords, agency] = await Promise.all([
        db.agencyStaff.findMany({
          where: { agencyId, isActive: true },
          select: { userId: true },
        }),
        db.agency.findUnique({ where: { id: agencyId }, select: { ownerId: true } }),
      ])
      const userIds = new Set(staffRecords.map((s: any) => s.userId))
      if (agency?.ownerId) userIds.add(agency.ownerId)
      return db.notification.count({
        where: { userId: { in: Array.from(userIds) } },
      })
    }
    case 'announcements':
      return db.announcement.count({ where: { agencyId } })
    case 'globalAnnouncements':
      return db.globalAnnouncement.count()
    case 'transactions':
      return db.transaction.count({ where: { agencyId } })
    case 'subscriptionPlans':
      return db.subscriptionPlan.count({ where: { isActive: true } })
    case 'planFeatures':
      return db.planFeature.count({ where: { plan: { isActive: true } } })
    case 'favorites':
      return db.favorite.count({ where: { agencyId } })
    case 'faqs':
      return db.fAQ.count()
    case 'agencyCategories':
      return db.agencyCategory.count()
    case 'smsSettings':
      return db.smsSettings.count()
    case 'paymentSettings':
      return db.paymentSettings.count()
    default:
      return 0
  }
}

export const initialSyncRoutes = app
