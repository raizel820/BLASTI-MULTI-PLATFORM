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
import { cloudDb } from '@blasti/cloud-db'
import { requireAuth, requireAgencyAccess, authErrorResponse, AuthError } from '../lib/auth'
import { getLatestSequence } from '../lib/sync-helpers'
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

const STAGE_DEFINITIONS: StageMeta[] = [
  { id: 'agency',           label: 'Agency',            mandatory: true  },
  { id: 'users',            label: 'Users',             mandatory: true  },
  { id: 'services',         label: 'Services',          mandatory: true  },
  { id: 'branches',         label: 'Branches',          mandatory: true  },
  { id: 'counters',         label: 'Counters',          mandatory: true  },
  { id: 'agencyStaff',      label: 'Agency Staff',      mandatory: true  },
  { id: 'queueSettings',    label: 'Queue Settings',    mandatory: true  },
  // Task 4-b §5-5: settings stages before operational data
  { id: 'smsSettings',      label: 'SMS Settings',      mandatory: false },
  { id: 'paymentSettings',  label: 'Payment Settings',  mandatory: false },
  { id: 'reservations',     label: 'Reservations',      mandatory: true  },
  { id: 'reviews',          label: 'Reviews',           mandatory: false },
  { id: 'favorites',        label: 'Favorites',         mandatory: false },
  { id: 'faqs',             label: 'FAQs',              mandatory: false },
  { id: 'notifications',    label: 'Notifications',     mandatory: false },
  { id: 'announcements',    label: 'Announcements',     mandatory: false },
  { id: 'globalAnnouncements', label: 'Global Announcements', mandatory: false },
  { id: 'transactions',     label: 'Transactions',      mandatory: false },
  { id: 'subscriptionPlans', label: 'Subscription Plans', mandatory: false },
  { id: 'planFeatures',     label: 'Plan Features',     mandatory: false },
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
      const record = await cloudDb.agency.findUnique({
        where: { id: agencyId },
      })
      const records = record ? [record] : []
      return { records, hasMore: false, total: records.length }
    }

    // ── 2. Users ──────────────────────────────────────────────────────────
    case 'users': {
      // Get user IDs from AgencyStaff, plus the agency owner
      const staffRecords = await cloudDb.agencyStaff.findMany({
        where: { agencyId, isActive: true },
        select: { userId: true },
      })
      const agency = await cloudDb.agency.findUnique({
        where: { id: agencyId },
        select: { ownerId: true },
      })
      const userIds = new Set(staffRecords.map((s: any) => s.userId))
      if (agency?.ownerId) userIds.add(agency.ownerId)

      if (userIds.size === 0) {
        return { records: [], hasMore: false, total: 0 }
      }

      const records = await cloudDb.user.findMany({
        where: { id: { in: Array.from(userIds) } },
        orderBy: { createdAt: 'asc' },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 3. Services ───────────────────────────────────────────────────────
    case 'services': {
      const records = await cloudDb.service.findMany({
        where: { agencyId },
        orderBy: { createdAt: 'asc' },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 4. Branches ───────────────────────────────────────────────────────
    case 'branches': {
      const records = await cloudDb.branch.findMany({
        where: { agencyId },
        orderBy: { createdAt: 'asc' },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 5. Counters ───────────────────────────────────────────────────────
    case 'counters': {
      // Get counters via branches belonging to this agency
      const branchIds = await cloudDb.branch.findMany({
        where: { agencyId },
        select: { id: true },
      })
      if (branchIds.length === 0) {
        return { records: [], hasMore: false, total: 0 }
      }
      const records = await cloudDb.counter.findMany({
        where: { branchId: { in: branchIds.map((b: any) => b.id) } },
        orderBy: { createdAt: 'asc' },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 6. AgencyStaff ────────────────────────────────────────────────────
    case 'agencyStaff': {
      const records = await cloudDb.agencyStaff.findMany({
        where: { agencyId },
        orderBy: { createdAt: 'asc' },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 7. QueueSettings ──────────────────────────────────────────────────
    case 'queueSettings': {
      const records = await cloudDb.queueSettings.findMany({
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
      const records = await cloudDb.smsSettings.findMany({
        select: {
          id: true, provider: true, apiUrl: true, senderName: true,
          enabled: true, smsPerReminder: true, maxSmsPerDay: true,
          testPhoneNumber: true, syncVersion: true,
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
      const records = await cloudDb.paymentSettings.findMany({
        select: {
          id: true, ccpEnabled: true, bankEnabled: true, electronicEnabled: true,
          ccpAccount: true, ccpKey: true, bankName: true, bankAccount: true,
          bankRib: true, ewalletNumber: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 8. Reservations (paginated) ───────────────────────────────────────
    case 'reservations': {
      return fetchPaginated(
        () => cloudDb.reservation.count({ where: { agencyId } }),
        () =>
          cloudDb.reservation.findMany({
            where: {
              agencyId,
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: pageSize + 1,
          }),
        pageSize,
      )
    }

    // ── 9. Reviews (paginated) ────────────────────────────────────────────
    case 'reviews': {
      return fetchPaginated(
        () => cloudDb.review.count({ where: { agencyId } }),
        () =>
          cloudDb.review.findMany({
            where: {
              agencyId,
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: pageSize + 1,
          }),
        pageSize,
      )
    }

    // ── 9b. Favorites (paginated, agencyId-scoped — Task 4-b §5-5) ────
    case 'favorites': {
      return fetchPaginated(
        () => cloudDb.favorite.count({ where: { agencyId } }),
        () =>
          cloudDb.favorite.findMany({
            where: {
              agencyId,
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            select: {
              id: true, userId: true, agencyId: true, syncVersion: true,
              createdAt: true, updatedAt: true,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: pageSize + 1,
          }),
        pageSize,
      )
    }

    // ── 9c. FAQs (global read-only content — Task 4-b §5-5) ──────────
    case 'faqs': {
      // Global content model (no agency scoping in schema — documented).
      // No isActive filter: mirrors the incremental pull so locally
      // deactivated FAQs keep their state instead of being resurrected.
      const records = await cloudDb.faq.findMany({
        select: {
          id: true, question: true, questionFr: true, questionAr: true,
          answer: true, answerFr: true, answerAr: true,
          category: true, order: true, isActive: true,
          syncVersion: true, createdAt: true, updatedAt: true,
        },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 10. Notifications (paginated) ─────────────────────────────────────
    case 'notifications': {
      // Get user IDs for this agency to filter notifications
      const staffRecords = await cloudDb.agencyStaff.findMany({
        where: { agencyId, isActive: true },
        select: { userId: true },
      })
      const agency = await cloudDb.agency.findUnique({
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
        () => cloudDb.notification.count({ where: { userId: { in: userIdArray } } }),
        () =>
          cloudDb.notification.findMany({
            where: {
              userId: { in: userIdArray },
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: pageSize + 1,
          }),
        pageSize,
      )
    }

    // ── 11. Announcements ─────────────────────────────────────────────────
    case 'announcements': {
      const records = await cloudDb.announcement.findMany({
        where: { agencyId },
        orderBy: { createdAt: 'asc' },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 11b. GlobalAnnouncements (global broadcast content — Task 4-b §5-5)
    case 'globalAnnouncements': {
      // SECURITY: platform-wide broadcast announcements — global by design
      // (meant for every agency/user; no agency scoping exists). Projection
      // mirrors the incremental pull (sync.ts 'GlobalAnnouncement').
      const records = await cloudDb.globalAnnouncement.findMany({
        select: {
          id: true, message: true, type: true, createdBy: true,
          syncVersion: true, createdAt: true, updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      })
      return { records, hasMore: false, total: records.length }
    }

    // ── 12. Transactions (paginated) ──────────────────────────────────────
    case 'transactions': {
      return fetchPaginated(
        () => cloudDb.transaction.count({ where: { agencyId } }),
        () =>
          cloudDb.transaction.findMany({
            where: {
              agencyId,
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: pageSize + 1,
          }),
        pageSize,
      )
    }

    // ── 13. SubscriptionPlans (global, not agency-scoped) ─────────────────
    case 'subscriptionPlans': {
      const records = await cloudDb.subscriptionPlan.findMany({
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
      const records = await cloudDb.planFeature.findMany({
        where: { plan: { isActive: true } },
        select: {
          id: true, planId: true, featureKey: true,
          featureName: true, featureNameAr: true, featureNameFr: true,
          enabled: true, limitValue: true, syncVersion: true,
          createdAt: true, updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
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
async function fetchPaginated(
  countFn: () => Promise<number>,
  findManyFn: () => Promise<any[]>,
  pageSize: number,
): Promise<{ records: any[]; nextCursor?: string; hasMore: boolean; total?: number }> {
  const [allRecords, total] = await Promise.all([findManyFn(), countFn()])

  const hasMore = allRecords.length > pageSize
  const records = hasMore ? allRecords.slice(0, pageSize) : allRecords
  const nextCursor = hasMore && records.length > 0 ? records[records.length - 1].id : undefined

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

    const { agencyId, stage, cursor, pageSize: rawPageSize, protocolVersion: _pv } = validation.data
    const pageSize = Math.min(rawPageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    // ── Authenticate & authorize ──────────────────────────────────────────
    const user = await requireAgencyAccess(c, agencyId)

    // ── Read current snapshot sequence ────────────────────────────────────
    // This is the sequence at which this snapshot was taken — all data is
    // consistent at this point.
    const snapshotSequence = await getLatestSequence(agencyId)

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
        cloudDb.agencyStaff.count({ where: { agencyId, isActive: true } }),
        cloudDb.agency.findUnique({ where: { id: agencyId }, select: { ownerId: true } }),
      ])
      return staffCount + (agency?.ownerId ? 1 : 0)
    }
    case 'services':
      return cloudDb.service.count({ where: { agencyId } })
    case 'branches':
      return cloudDb.branch.count({ where: { agencyId } })
    case 'counters': {
      const branchIds = await cloudDb.branch.findMany({
        where: { agencyId },
        select: { id: true },
      })
      return cloudDb.counter.count({
        where: { branchId: { in: branchIds.map((b: any) => b.id) } },
      })
    }
    case 'agencyStaff':
      return cloudDb.agencyStaff.count({ where: { agencyId } })
    case 'queueSettings':
      return cloudDb.queueSettings.count({ where: { agencyId } })
    case 'reservations':
      return cloudDb.reservation.count({ where: { agencyId } })
    case 'reviews':
      return cloudDb.review.count({ where: { agencyId } })
    case 'notifications': {
      const [staffRecords, agency] = await Promise.all([
        cloudDb.agencyStaff.findMany({
          where: { agencyId, isActive: true },
          select: { userId: true },
        }),
        cloudDb.agency.findUnique({ where: { id: agencyId }, select: { ownerId: true } }),
      ])
      const userIds = new Set(staffRecords.map((s: any) => s.userId))
      if (agency?.ownerId) userIds.add(agency.ownerId)
      return cloudDb.notification.count({
        where: { userId: { in: Array.from(userIds) } },
      })
    }
    case 'announcements':
      return cloudDb.announcement.count({ where: { agencyId } })
    case 'globalAnnouncements':
      return cloudDb.globalAnnouncement.count()
    case 'transactions':
      return cloudDb.transaction.count({ where: { agencyId } })
    case 'subscriptionPlans':
      return cloudDb.subscriptionPlan.count({ where: { isActive: true } })
    case 'planFeatures':
      return cloudDb.planFeature.count({ where: { plan: { isActive: true } } })
    case 'favorites':
      return cloudDb.favorite.count({ where: { agencyId } })
    case 'faqs':
      return cloudDb.faq.count()
    case 'smsSettings':
      return cloudDb.smsSettings.count()
    case 'paymentSettings':
      return cloudDb.paymentSettings.count()
    default:
      return 0
  }
}

export const initialSyncRoutes = app
