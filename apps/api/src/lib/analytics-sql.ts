// ─── analytics-sql.ts (R-6d — SQL pushdown for the 54-a analytics routes) ────
//
// WHY THIS EXISTS (AUD-1 live benchmark): the analytics routes fetched every
// Reservation row inside the period and aggregated in JS (.filter/.reduce
// loops in lib/analytics-engine.ts) — the 90d overview was the worst endpoint
// at ~194ms because ~10k rows crossed the wire just to be counted. This module
// moves the aggregation into PostgreSQL (GROUP BY / GROUPING SETS / FILTER)
// so only aggregate ROWS cross the wire, while keeping the exact response
// shape the 54-a routes already return (web + desktop consume them).
//
// Semantics preserved from lib/analytics-engine.ts (do not change):
//   - walkIn  = isWalkIn true
//   - online  = !isWalkIn AND userId != null
//   - wait    = calledAt − joinedAt        (rows with calledAt)
//   - service = completedAt − calledAt     (rows with both)
//   - rates are 0–100 with one decimal (0 when total = 0)
//   - durations/averages are minutes with one decimal, null when no data
//   - timeseries buckets are zero-filled by the caller
//
// TIMEZONE (R-6d): buckets are cut on the Africa/Algiers wall clock (fixed
// UTC+01:00, no DST — see lib/dates.ts). The DB stores UTC instants in
// `timestamp without time zone` columns (Prisma convention), so the local
// time of a row is ("joinedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Algiers'.
//
// INDEXING: every query filters by the scope predicate FIRST (agencyId and/or
// userId — prefix of Reservation(agencyId,status,queueNumber) /
// (agencyId,serviceId,status) / (userId,status)) plus a joinedAt range, so the
// planner reads the scoped slice through an index instead of the table.

import { db, Prisma } from '@blasti/db'
import {
  round1,
  type AnalyticsGranularity,
  type ResolvedPeriodRange,
} from './analytics-dashboard'
import {
  rateOf,
  hoursSpan,
  RESERVATION_STATUS_KEYS,
  type ReservationAggregate,
  type GroupReservationStats,
} from './analytics-engine'
import {
  algiersDateKey,
  algiersHourKey,
  algiersMonthKey,
  algiersDayStartUtc,
  ALGIERS_TZ,
} from './dates'

// ─── Scope → SQL WHERE ───────────────────────────────────────────────────────

export interface AnalyticsScope {
  /** Agency scoping (owner/staff analytics) — index prefix on (agencyId,…). */
  agencyId?: string
  /** Customer scoping (personal analytics) — index prefix on (userId,status). */
  userId?: string
  /** Inclusive joinedAt window (UTC instants). */
  start?: Date
  end?: Date
  /**
   * Staff counter/branch narrowing — mirrors routes/staff-analytics
   * fetchStaffScopedRows: rows served at counters of the staff member's
   * branch (counter.branch.agencyId check included) OR at their own
   * assigned counters (Counter.staffId).
   */
  counterScope?: {
    agencyId: string
    branchId: string | null
    counterIds: string[]
  }
}

/**
 * JS Date → 'YYYY-MM-DDTHH:MM:SS.mmm' UTC wall-clock literal matching how
 * Prisma stores DateTime in `timestamp without time zone` columns. Bound as a
 * text param and cast with ::timestamp so the comparison is session-TimeZone
 * independent.
 */
function utcStamp(d: Date): string {
  return d.toISOString().slice(0, 23)
}

/** Naive-local expression cutting a UTC instant on the Algiers wall clock. */
const LOCAL_TS = Prisma.raw(`("joinedAt" AT TIME ZONE 'UTC') AT TIME ZONE '${ALGIERS_TZ}'`)

export function buildScopeWhere(scope: AnalyticsScope): Prisma.Sql {
  const conds: Prisma.Sql[] = []
  if (scope.agencyId) conds.push(Prisma.sql`"agencyId" = ${scope.agencyId}`)
  if (scope.userId) conds.push(Prisma.sql`"userId" = ${scope.userId}`)
  if (scope.start) conds.push(Prisma.sql`"joinedAt" >= ${utcStamp(scope.start)}::timestamp`)
  if (scope.end) conds.push(Prisma.sql`"joinedAt" <= ${utcStamp(scope.end)}::timestamp`)
  if (scope.counterScope) {
    const { agencyId, branchId, counterIds } = scope.counterScope
    const arms: Prisma.Sql[] = [
      branchId
        ? Prisma.sql`"counterId" IN (SELECT c.id FROM "Counter" c JOIN "Branch" b ON b.id = c."branchId" WHERE b."agencyId" = ${agencyId} AND c."branchId" = ${branchId})`
        : Prisma.sql`"counterId" IN (SELECT c.id FROM "Counter" c JOIN "Branch" b ON b.id = c."branchId" WHERE b."agencyId" = ${agencyId})`,
    ]
    if (counterIds.length > 0) {
      arms.push(Prisma.sql`"counterId" IN (${Prisma.join(counterIds)})`)
    }
    conds.push(Prisma.sql`(${Prisma.join(arms, ' OR ')})`)
  }
  return conds.length > 0 ? Prisma.join(conds, ' AND ') : Prisma.raw('TRUE')
}

// ─── KPIs + status counts (single scan, GROUPING SETS ((), (status))) ────────

export interface SqlReservationKpis {
  total: number
  /** Exact per-status counts incl. rare statuses (mirrors kpis.byStatus). */
  byStatus: Record<string, number>
  called: number
  walkIn: number
  online: number
  uniqueCustomers: number
  avgWaitMinutes: number | null
  medianWaitMinutes: number | null
  maxWaitMinutes: number | null
  /** Shortest wait in minutes — my-queue-history wait.shortestMinutes. */
  minWaitMinutes: number | null
  avgServiceMinutes: number | null
  medianServiceMinutes: number | null
  maxServiceMinutes: number | null
  /** Rows with fixedTimeEnabled = true (my-reservations byType.fixedTime). */
  fixedTime: number
}

interface KpiRow {
  g: number
  status: string | null
  cnt: number
  called: number
  walkIn: number
  online: number
  uniqueCustomers: number
  avgWaitMinutes: number | null
  medianWaitMinutes: number | null
  maxWaitMinutes: number | null
  minWaitMinutes: number | null
  avgServiceMinutes: number | null
  medianServiceMinutes: number | null
  maxServiceMinutes: number | null
  fixedTime: number
}

export async function sqlReservationKpis(scope: AnalyticsScope): Promise<SqlReservationKpis> {
  const where = buildScopeWhere(scope)
  const rows = await db.$queryRaw<KpiRow[]>`
    SELECT
      GROUPING("status") AS g,
      "status",
      COUNT(*)::int AS cnt,
      COUNT(*) FILTER (WHERE "calledAt" IS NOT NULL)::int AS called,
      COUNT(*) FILTER (WHERE "isWalkIn")::int AS "walkIn",
      COUNT(*) FILTER (WHERE NOT "isWalkIn" AND "userId" IS NOT NULL)::int AS "online",
      COUNT(DISTINCT "userId")::int AS "uniqueCustomers",
      AVG(CASE WHEN "calledAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("calledAt" - "joinedAt")) / 60.0 END)::float8 AS "avgWaitMinutes",
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("calledAt" - "joinedAt")) / 60.0) FILTER (WHERE "calledAt" IS NOT NULL)::float8 AS "medianWaitMinutes",
      MAX(CASE WHEN "calledAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("calledAt" - "joinedAt")) / 60.0 END)::float8 AS "maxWaitMinutes",
      MIN(CASE WHEN "calledAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("calledAt" - "joinedAt")) / 60.0 END)::float8 AS "minWaitMinutes",
      AVG(CASE WHEN "calledAt" IS NOT NULL AND "completedAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("completedAt" - "calledAt")) / 60.0 END)::float8 AS "avgServiceMinutes",
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("completedAt" - "calledAt")) / 60.0) FILTER (WHERE "calledAt" IS NOT NULL AND "completedAt" IS NOT NULL)::float8 AS "medianServiceMinutes",
      MAX(CASE WHEN "calledAt" IS NOT NULL AND "completedAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("completedAt" - "calledAt")) / 60.0 END)::float8 AS "maxServiceMinutes",
      COUNT(*) FILTER (WHERE "fixedTimeEnabled")::int AS "fixedTime"
    FROM "Reservation"
    WHERE ${where}
    GROUP BY GROUPING SETS ((), ("status"))
  `

  const totalRow = rows.find((r) => r.g === 1)
  const byStatus: Record<string, number> = {}
  for (const r of rows) {
    if (r.g === 0 && r.status) byStatus[r.status] = r.cnt
  }

  const roundOrNull = (v: number | null | undefined): number | null =>
    v === null || v === undefined ? null : round1(v)

  return {
    total: totalRow?.cnt ?? 0,
    byStatus,
    called: totalRow?.called ?? 0,
    walkIn: totalRow?.walkIn ?? 0,
    online: totalRow?.online ?? 0,
    uniqueCustomers: totalRow?.uniqueCustomers ?? 0,
    avgWaitMinutes: roundOrNull(totalRow?.avgWaitMinutes),
    medianWaitMinutes: roundOrNull(totalRow?.medianWaitMinutes),
    maxWaitMinutes: roundOrNull(totalRow?.maxWaitMinutes),
    minWaitMinutes: roundOrNull(totalRow?.minWaitMinutes),
    avgServiceMinutes: roundOrNull(totalRow?.avgServiceMinutes),
    medianServiceMinutes: roundOrNull(totalRow?.medianServiceMinutes),
    maxServiceMinutes: roundOrNull(totalRow?.maxServiceMinutes),
    fixedTime: totalRow?.fixedTime ?? 0,
  }
}

// ─── Timeseries (GROUP BY one bucket key on the Algiers wall clock) ──────────

const BUCKET_EXPR: Record<AnalyticsGranularity, string> = {
  daily: `to_char(("joinedAt" AT TIME ZONE 'UTC') AT TIME ZONE '${ALGIERS_TZ}', 'YYYY-MM-DD')`,
  monthly: `to_char(("joinedAt" AT TIME ZONE 'UTC') AT TIME ZONE '${ALGIERS_TZ}', 'YYYY-MM')`,
  hourly: `to_char(("joinedAt" AT TIME ZONE 'UTC') AT TIME ZONE '${ALGIERS_TZ}', 'YYYY-MM-DD"T"HH24')`,
}

export interface SqlBucketRow {
  bucket: string
  total: number
  completed: number
  cancelled: number
  noShow: number
  walkIn: number
  online: number
  waitCount: number
  waitSumMinutes: number
}

export async function sqlReservationTimeseries(
  scope: AnalyticsScope,
  granularity: AnalyticsGranularity,
): Promise<SqlBucketRow[]> {
  const where = buildScopeWhere(scope)
  return db.$queryRaw<SqlBucketRow[]>`
    SELECT
      ${Prisma.raw(BUCKET_EXPR[granularity])} AS bucket,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE "status" = 'COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE "status" = 'CANCELLED')::int AS cancelled,
      COUNT(*) FILTER (WHERE "status" = 'NO_SHOW')::int AS "noShow",
      COUNT(*) FILTER (WHERE "isWalkIn")::int AS "walkIn",
      COUNT(*) FILTER (WHERE NOT "isWalkIn" AND "userId" IS NOT NULL)::int AS "online",
      COUNT(*) FILTER (WHERE "calledAt" IS NOT NULL)::int AS "waitCount",
      COALESCE(SUM(CASE WHEN "calledAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("calledAt" - "joinedAt")) / 60.0 END), 0)::float8 AS "waitSumMinutes"
    FROM "Reservation"
    WHERE ${where}
    GROUP BY 1
    ORDER BY 1
  `
}

/**
 * Ordered zero-fill bucket keys ('YYYY-MM-DD' | 'YYYY-MM' | 'YYYY-MM-DDTHH')
 * cut on the Algiers wall clock — the same key space the SQL bucketing
 * produces. Replaces utcDateKey-based buildBucketKeys at R-6d call sites.
 */
export function algiersBucketKeys(
  start: Date,
  end: Date,
  granularity: AnalyticsGranularity,
): string[] {
  const keys: string[] = []
  if (granularity === 'daily') {
    // No DST → every Algiers day is exactly 24h; stepping the algiers-midnight
    // instant by +24h stays on algiers-midnights.
    const cursor = algiersDayStartUtc(algiersDateKey(start))
    while (cursor.getTime() <= end.getTime()) {
      keys.push(algiersDateKey(cursor))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  } else if (granularity === 'hourly') {
    const cursor = new Date(start.getTime())
    cursor.setUTCMinutes(0, 0, 0)
    while (cursor.getTime() <= end.getTime()) {
      keys.push(algiersHourKey(cursor))
      cursor.setUTCHours(cursor.getUTCHours() + 1)
    }
  } else {
    const startKey = algiersMonthKey(start)
    const endKey = algiersMonthKey(end)
    let y = Number(startKey.slice(0, 4))
    let m = Number(startKey.slice(5, 7))
    const endY = Number(endKey.slice(0, 4))
    const endM = Number(endKey.slice(5, 7))
    while (y < endY || (y === endY && m <= endM)) {
      keys.push(`${y}-${String(m).padStart(2, '0')}`)
      m += 1
      if (m > 12) {
        m = 1
        y += 1
      }
    }
  }
  return keys
}

// ─── Traffic (hour-of-day / weekday / busiest-day — one scan, 3 groupings) ───

export interface SqlTraffic {
  /** 24 entries, hour 0..23 (Algiers local hour), zero-filled. */
  hourly: Array<{ hour: number; count: number }>
  /** 7 entries, weekday 0..6 (0 = Sunday — matches getUTCDay), zero-filled. */
  weekday: Array<{ weekday: number; count: number }>
  /** 'YYYY-MM-DD' (Algiers) with the most joinedAt rows, null when empty. */
  busiestDay: string | null
}

interface TrafficRow {
  gh: number
  gw: number
  gd: number
  h: number | null
  dw: number | null
  dk: string | null
  cnt: number
}

export async function sqlReservationTraffic(scope: AnalyticsScope): Promise<SqlTraffic> {
  const where = buildScopeWhere(scope)
  const rows = await db.$queryRaw<TrafficRow[]>`
    SELECT
      GROUPING("h") AS gh,
      GROUPING("dw") AS gw,
      GROUPING("dk") AS gd,
      "h", "dw", "dk",
      COUNT(*)::int AS cnt
    FROM (
      SELECT
        EXTRACT(HOUR FROM ${LOCAL_TS})::int AS "h",
        EXTRACT(DOW FROM ${LOCAL_TS})::int AS "dw",
        to_char(${LOCAL_TS}, 'YYYY-MM-DD') AS "dk"
      FROM "Reservation"
      WHERE ${where}
    ) t
    GROUP BY GROUPING SETS (("h"), ("dw"), ("dk"))
  `

  const hourly = new Array<number>(24).fill(0)
  const weekday = new Array<number>(7).fill(0)
  let busiestDay: string | null = null
  let busiestDayCount = 0
  for (const r of rows) {
    if (r.gh === 0 && r.h !== null) hourly[r.h] = r.cnt
    if (r.gw === 0 && r.dw !== null) weekday[r.dw] = r.cnt
    // Deterministic tie-break (count DESC, then earliest day). The JS engine
    // kept the first key it happened to iterate — ties were undefined there.
    if (r.gd === 0 && r.dk !== null && (r.cnt > busiestDayCount || (r.cnt === busiestDayCount && busiestDay !== null && r.dk < busiestDay))) {
      busiestDayCount = r.cnt
      busiestDay = r.dk
    }
  }

  return {
    hourly: hourly.map((count, hour) => ({ hour, count })),
    weekday: weekday.map((count, wd) => ({ weekday: wd, count })),
    busiestDay,
  }
}

// ─── Grouped sub-aggregations (service / counter / agency / user) ────────────

export type AnalyticsGroupDim = 'serviceId' | 'counterId' | 'agencyId' | 'userId'

export interface SqlGroupStat {
  key: string
  count: number
  completed: number
  cancelled: number
  noShow: number
  walkIn: number
  online: number
  /** round1(mean wait minutes) over rows with calledAt — null when none. */
  avgWaitMinutes: number | null
  /** round1(mean service minutes) over rows with both stamps — null when none. */
  avgServiceMinutes: number | null
}

interface GroupRow {
  [k: string]: unknown
}

/**
 * Group scoped reservations by one or more dimensions in a single scan
 * (GROUPING SETS). Mirrors lib/analytics-engine.groupReservationStats:
 * rows whose dimension value is NULL are skipped (keyOf → null → continue),
 * and derived fields (completionRate / avg*) are computed by the caller or
 * via groupStatExtras().
 */
export async function sqlReservationGroups(
  scope: AnalyticsScope,
  dims: AnalyticsGroupDim[],
): Promise<Map<AnalyticsGroupDim, SqlGroupStat[]>> {
  if (dims.length === 0) return new Map()
  const where = buildScopeWhere(scope)

  const groupingFlags = dims.map((d) => Prisma.sql`GROUPING(${Prisma.raw(`"${d}"`)}) AS ${Prisma.raw(`g_${d}`)}`)
  const dimCols = dims.map((d) => Prisma.raw(`"${d}"`))
  const sets = dims.map((d) => Prisma.sql`("${Prisma.raw(d)}")`)

  const rows = await db.$queryRaw<GroupRow[]>`
    SELECT
      ${Prisma.join(groupingFlags, ', ')},
      ${Prisma.join(dimCols, ', ')},
      COUNT(*)::int AS cnt,
      COUNT(*) FILTER (WHERE "status" = 'COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE "status" = 'CANCELLED')::int AS cancelled,
      COUNT(*) FILTER (WHERE "status" = 'NO_SHOW')::int AS "noShow",
      COUNT(*) FILTER (WHERE "isWalkIn")::int AS "walkIn",
      COUNT(*) FILTER (WHERE NOT "isWalkIn" AND "userId" IS NOT NULL)::int AS "online",
      COUNT(*) FILTER (WHERE "calledAt" IS NOT NULL)::int AS "waitCount",
      COALESCE(SUM(CASE WHEN "calledAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("calledAt" - "joinedAt")) / 60.0 END), 0)::float8 AS "waitSumMinutes",
      COUNT(*) FILTER (WHERE "calledAt" IS NOT NULL AND "completedAt" IS NOT NULL)::int AS "svcCount",
      COALESCE(SUM(CASE WHEN "calledAt" IS NOT NULL AND "completedAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("completedAt" - "calledAt")) / 60.0 END), 0)::float8 AS "svcSumMinutes"
    FROM "Reservation"
    WHERE ${where}
    GROUP BY GROUPING SETS (${Prisma.join(sets, ', ')})
  `

  const result = new Map<AnalyticsGroupDim, SqlGroupStat[]>()
  for (const dim of dims) result.set(dim, [])

  for (const row of rows) {
    for (const dim of dims) {
      if (row[`g_${dim}`] !== 0) continue
      const key = row[dim]
      if (key === null || key === undefined) continue // engine skips null keys
      const waitCount = Number(row.waitCount ?? 0)
      const svcCount = Number(row.svcCount ?? 0)
      result.get(dim)!.push({
        key: String(key),
        count: Number(row.cnt ?? 0),
        completed: Number(row.completed ?? 0),
        cancelled: Number(row.cancelled ?? 0),
        noShow: Number(row.noShow ?? 0),
        walkIn: Number(row.walkIn ?? 0),
        online: Number(row.online ?? 0),
        avgWaitMinutes: waitCount > 0 ? round1(Number(row.waitSumMinutes ?? 0) / waitCount) : null,
        avgServiceMinutes: svcCount > 0 ? round1(Number(row.svcSumMinutes ?? 0) / svcCount) : null,
      })
    }
  }
  return result
}

/** completionRate in the engine's 0–100 one-decimal convention. */
export function groupStatCompletionRate(s: { count: number; completed: number }): number {
  return s.count > 0 ? round1((s.completed / s.count) * 100) : 0
}

/** Bucket rows → engine-shaped timeseries with zero-filled bucket keys. */
export function zeroFilledTimeseries(
  rows: SqlBucketRow[],
  bucketKeys: string[],
): Array<{
  bucket: string
  total: number
  completed: number
  cancelled: number
  noShow: number
  walkIn: number
  online: number
  avgWaitMinutes: number | null
}> {
  const byKey = new Map(rows.map((r) => [r.bucket, r]))
  return bucketKeys.map((key) => {
    const r = byKey.get(key)
    const waitCount = r?.waitCount ?? 0
    return {
      bucket: key,
      total: r?.total ?? 0,
      completed: r?.completed ?? 0,
      cancelled: r?.cancelled ?? 0,
      noShow: r?.noShow ?? 0,
      walkIn: r?.walkIn ?? 0,
      online: r?.online ?? 0,
      avgWaitMinutes: waitCount > 0 ? round1((r?.waitSumMinutes ?? 0) / waitCount) : null,
    }
  })
}

// ─── R-6e — Owner analytics pushdown (agency.ts §17/§18) ─────────────────────
//
// GET /api/agency/analytics/overview + /analytics/reservations historically
// fetched EVERY Reservation row of the period (fetchOwnerReservationRows) and
// aggregated in JS (lib/analytics-engine.ts) — the AUD-1 worst endpoint at
// ~194ms/90d. The helpers below push the aggregation into PostgreSQL while
// returning the EXACT same shapes (ReservationAggregate /
// GroupReservationStats), so web + desktop consumers cannot tell the
// difference.
//
// PARITY RULES (mirror lib/analytics-engine.ts — do not change):
//   - BUCKETS ARE UTC here, on purpose: aggregateReservations keys buckets
//     with utcDateKey/utcMonthKey/utcHourKey and getUTCHours/getUTCDay, and
//     the routes zero-fill with range.bucketKeys (UTC — see
//     analytics-dashboard.buildBucketKeys). The R-6d Algiers helpers above
//     belong to the routes that adopted Algiers bucketing; these two routes
//     did NOT (response-shape parity requirement), so the SQL must bucket the
//     same way the JS did. `timestamp without time zone` columns hold UTC
//     instants, so to_char/EXTRACT on the raw column ARE the UTC values.
//   - walkIn = isWalkIn; online = !isWalkIn AND userId NOT NULL
//   - wait = calledAt − joinedAt (rows with calledAt); service = completedAt
//     − calledAt (rows with both); mean/median/max in minutes, round1, null
//     when no data
//   - rates are 0–100 with one decimal (0 when total = 0)
//   - byStatus/statusDistribution zero-fill the 6 RESERVATION_STATUS_KEYS
//   - peak "first max wins" iteration preserved
//
// Float note: AVG/SUM of EXTRACT(EPOCH …)/60.0 doubles vs the JS mean of
// per-row minute doubles can differ in the last ulp; round1 absorbs it except
// for values sitting within ~1e-12 of an exact .x5-minute boundary — the same
// accepted trade-off the R-6d Algiers helpers made for the 54-a routes.

/** Mirrors the query-param filters fetchOwnerReservationRows applies. */
export interface OwnerAnalyticsFilters {
  serviceId?: string
  counterId?: string
  branchId?: string
  staffId?: string
  status?: string
  channel?: 'walkIn' | 'online'
}

/**
 * SQL WHERE mirroring fetchOwnerReservationRows: agency scope + inclusive
 * joinedAt window + the §3.2 org/channel/status filters.
 */
export function buildOwnerWhere(
  agencyId: string,
  rangeStart: Date,
  rangeEnd: Date,
  filters: OwnerAnalyticsFilters = {},
): Prisma.Sql {
  const conds: Prisma.Sql[] = [
    Prisma.sql`"agencyId" = ${agencyId}`,
    Prisma.sql`"joinedAt" >= ${utcStamp(rangeStart)}::timestamp`,
    Prisma.sql`"joinedAt" <= ${utcStamp(rangeEnd)}::timestamp`,
  ]
  if (filters.serviceId) conds.push(Prisma.sql`"serviceId" = ${filters.serviceId}`)
  if (filters.counterId) conds.push(Prisma.sql`"counterId" = ${filters.counterId}`)
  if (filters.status) conds.push(Prisma.sql`"status" = ${filters.status}`)
  if (filters.channel === 'walkIn') conds.push(Prisma.sql`"isWalkIn" = TRUE`)
  if (filters.channel === 'online') conds.push(Prisma.sql`"isWalkIn" = FALSE`)
  if (filters.branchId || filters.staffId) {
    const counterConds: Prisma.Sql[] = []
    if (filters.branchId) counterConds.push(Prisma.sql`"branchId" = ${filters.branchId}`)
    if (filters.staffId) counterConds.push(Prisma.sql`"staffId" = ${filters.staffId}`)
    conds.push(
      Prisma.sql`"counterId" IN (SELECT "id" FROM "Counter" WHERE ${Prisma.join(counterConds, ' AND ')})`,
    )
  }
  return Prisma.join(conds, ' AND ')
}

// UTC bucket expressions — the to_char twins of utcDateKey/utcMonthKey/utcHourKey.
const UTC_BUCKET_EXPR: Record<AnalyticsGranularity, string> = {
  daily: `to_char("joinedAt", 'YYYY-MM-DD')`,
  monthly: `to_char("joinedAt", 'YYYY-MM')`,
  hourly: `to_char("joinedAt", 'YYYY-MM-DD"T"HH24')`,
}

interface SqlKpiRow {
  g: number
  status: string | null
  cnt: number
  walkIn: number
  online: number
  uniqueCustomers: number
  avgWaitMinutes: number | null
  medianWaitMinutes: number | null
  maxWaitMinutes: number | null
  avgServiceMinutes: number | null
  medianServiceMinutes: number | null
  maxServiceMinutes: number | null
}

interface SqlUtcBucketRow {
  bucket: string
  total: number
  completed: number
  cancelled: number
  noShow: number
  walkIn: number
  online: number
  waitCount: number
  waitSumMinutes: number
}

interface SqlUtcTrafficRow {
  gh: number
  gw: number
  gd: number
  h: number | null
  dw: number | null
  dk: string | null
  cnt: number
}

/**
 * SQL twin of lib/analytics-engine.aggregateReservations — same return type,
 * same zero-filling, same rounding. One scan each for KPIs, timeseries
 * buckets and traffic instead of one wire-transfer of every row.
 */
export async function sqlAggregateReservations(
  agencyId: string,
  rangeStart: Date,
  rangeEnd: Date,
  range: ResolvedPeriodRange,
  filters: OwnerAnalyticsFilters = {},
): Promise<ReservationAggregate> {
  const where = buildOwnerWhere(agencyId, rangeStart, rangeEnd, filters)

  const [kpiRows, bucketRows, trafficRows] = await Promise.all([
    db.$queryRaw<SqlKpiRow[]>`
      SELECT
        GROUPING("status") AS g,
        "status",
        COUNT(*)::int AS cnt,
        COUNT(*) FILTER (WHERE "isWalkIn")::int AS "walkIn",
        COUNT(*) FILTER (WHERE NOT "isWalkIn" AND "userId" IS NOT NULL)::int AS "online",
        COUNT(DISTINCT "userId")::int AS "uniqueCustomers",
        AVG(CASE WHEN "calledAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("calledAt" - "joinedAt")) / 60.0 END)::float8 AS "avgWaitMinutes",
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("calledAt" - "joinedAt")) / 60.0) FILTER (WHERE "calledAt" IS NOT NULL)::float8 AS "medianWaitMinutes",
        MAX(CASE WHEN "calledAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("calledAt" - "joinedAt")) / 60.0 END)::float8 AS "maxWaitMinutes",
        AVG(CASE WHEN "calledAt" IS NOT NULL AND "completedAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("completedAt" - "calledAt")) / 60.0 END)::float8 AS "avgServiceMinutes",
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("completedAt" - "calledAt")) / 60.0) FILTER (WHERE "calledAt" IS NOT NULL AND "completedAt" IS NOT NULL)::float8 AS "medianServiceMinutes",
        MAX(CASE WHEN "calledAt" IS NOT NULL AND "completedAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("completedAt" - "calledAt")) / 60.0 END)::float8 AS "maxServiceMinutes"
      FROM "Reservation"
      WHERE ${where}
      GROUP BY GROUPING SETS ((), ("status"))
    `,
    db.$queryRaw<SqlUtcBucketRow[]>`
      SELECT
        ${Prisma.raw(UTC_BUCKET_EXPR[range.granularity])} AS bucket,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE "status" = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (WHERE "status" = 'CANCELLED')::int AS cancelled,
        COUNT(*) FILTER (WHERE "status" = 'NO_SHOW')::int AS "noShow",
        COUNT(*) FILTER (WHERE "isWalkIn")::int AS "walkIn",
        COUNT(*) FILTER (WHERE NOT "isWalkIn" AND "userId" IS NOT NULL)::int AS "online",
        COUNT(*) FILTER (WHERE "calledAt" IS NOT NULL)::int AS "waitCount",
        COALESCE(SUM(CASE WHEN "calledAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("calledAt" - "joinedAt")) / 60.0 END), 0)::float8 AS "waitSumMinutes"
      FROM "Reservation"
      WHERE ${where}
      GROUP BY 1
    `,
    db.$queryRaw<SqlUtcTrafficRow[]>`
      SELECT
        GROUPING("h") AS gh,
        GROUPING("dw") AS gw,
        GROUPING("dk") AS gd,
        "h", "dw", "dk",
        COUNT(*)::int AS cnt
      FROM (
        SELECT
          EXTRACT(HOUR FROM "joinedAt")::int AS "h",
          EXTRACT(DOW FROM "joinedAt")::int AS "dw",
          to_char("joinedAt", 'YYYY-MM-DD') AS "dk"
        FROM "Reservation"
        WHERE ${where}
      ) t
      GROUP BY GROUPING SETS (("h"), ("dw"), ("dk"))
      ORDER BY "dk" ASC
    `,
  ])

  const totalRow = kpiRows.find((r) => r.g === 1)
  const total = totalRow?.cnt ?? 0

  // Engine parity: byStatus zero-fills the 6 known keys (unknown statuses
  // never occur — updateReservationStatusSchema restricts writes to them).
  const byStatus: Record<string, number> = {}
  for (const s of RESERVATION_STATUS_KEYS) byStatus[s] = 0
  for (const r of kpiRows) {
    if (r.g === 0 && r.status) byStatus[r.status] = (byStatus[r.status] ?? 0) + r.cnt
  }

  const roundOrNull = (v: number | null | undefined): number | null =>
    v === null || v === undefined ? null : round1(v)

  const kpis = {
    total,
    byStatus,
    completed: byStatus.COMPLETED ?? 0,
    cancelled: byStatus.CANCELLED ?? 0,
    noShow: byStatus.NO_SHOW ?? 0,
    waiting: byStatus.WAITING ?? 0,
    called: byStatus.CALLED ?? 0,
    serving: byStatus.SERVING ?? 0,
    completionRate: rateOf(byStatus.COMPLETED ?? 0, total),
    cancellationRate: rateOf(byStatus.CANCELLED ?? 0, total),
    noShowRate: rateOf(byStatus.NO_SHOW ?? 0, total),
    walkInCount: totalRow?.walkIn ?? 0,
    onlineCount: totalRow?.online ?? 0,
    walkInRate: rateOf(totalRow?.walkIn ?? 0, total),
    onlineRate: rateOf(totalRow?.online ?? 0, total),
    uniqueCustomers: totalRow?.uniqueCustomers ?? 0,
    avgWaitMinutes: roundOrNull(totalRow?.avgWaitMinutes),
    medianWaitMinutes: roundOrNull(totalRow?.medianWaitMinutes),
    maxWaitMinutes: roundOrNull(totalRow?.maxWaitMinutes),
    avgServiceMinutes: roundOrNull(totalRow?.avgServiceMinutes),
    medianServiceMinutes: roundOrNull(totalRow?.medianServiceMinutes),
    maxServiceMinutes: roundOrNull(totalRow?.maxServiceMinutes),
    customersPerHour: total > 0 ? round1(total / hoursSpan(rangeStart, rangeEnd)) : null,
  }

  // Timeseries: zero-fill with the SAME bucket keys the JS engine used.
  const bucketByKey = new Map(bucketRows.map((r) => [r.bucket, r]))
  const timeseries = range.bucketKeys.map((key) => {
    const b = bucketByKey.get(key)
    const waitCount = b?.waitCount ?? 0
    return {
      bucket: key,
      total: b?.total ?? 0,
      completed: b?.completed ?? 0,
      cancelled: b?.cancelled ?? 0,
      noShow: b?.noShow ?? 0,
      walkIn: b?.walkIn ?? 0,
      online: b?.online ?? 0,
      avgWaitMinutes: waitCount > 0 ? round1((b?.waitSumMinutes ?? 0) / waitCount) : null,
    }
  })

  // Traffic + peak (first-max-wins preserved from the engine loops).
  const hourlyCounts = new Array<number>(24).fill(0)
  const weekdayCounts = new Array<number>(7).fill(0)
  let busiestHour: number | null = null
  let busiestHourCount = 0
  let busiestWeekday: number | null = null
  let busiestWeekdayCount = 0
  let busiestDay: string | null = null
  let busiestDayCount = 0
  for (const r of trafficRows) {
    if (r.gh === 0 && r.h !== null) hourlyCounts[r.h] = r.cnt
    if (r.gw === 0 && r.dw !== null) weekdayCounts[r.dw] = r.cnt
    if (r.gd === 0 && r.dk !== null && r.cnt > busiestDayCount) {
      busiestDayCount = r.cnt
      busiestDay = r.dk
    }
  }
  hourlyCounts.forEach((count, hour) => {
    if (count > busiestHourCount) {
      busiestHourCount = count
      busiestHour = hour
    }
  })
  weekdayCounts.forEach((count, weekday) => {
    if (count > busiestWeekdayCount) {
      busiestWeekdayCount = count
      busiestWeekday = weekday
    }
  })

  return {
    kpis,
    statusDistribution: RESERVATION_STATUS_KEYS.map((status) => ({ status, count: byStatus[status] ?? 0 })),
    timeseries,
    hourlyTraffic: hourlyCounts.map((count, hour) => ({ hour, count })),
    weekdayTraffic: weekdayCounts.map((count, weekday) => ({ weekday, count })),
    peak: { busiestHour, busiestWeekday, busiestDay },
  }
}

/** SQL twin of the ratings half of aggregateRatings (count/average/distribution). */
export interface SqlRatingAggregate {
  count: number
  average: number | null
  /** 5 buckets, index 0 = 1 star. */
  distribution: number[]
}

export async function sqlReservationRatings(
  agencyId: string,
  rangeStart: Date,
  rangeEnd: Date,
  filters: OwnerAnalyticsFilters = {},
): Promise<SqlRatingAggregate> {
  const where = buildOwnerWhere(agencyId, rangeStart, rangeEnd, filters)
  const rows = await db.$queryRaw<Array<{ cnt: number; avg: number | null; s1: number; s2: number; s3: number; s4: number; s5: number }>>`
    SELECT
      COUNT(*) FILTER (WHERE "rating" >= 1 AND "rating" <= 5)::int AS cnt,
      AVG("rating") FILTER (WHERE "rating" >= 1 AND "rating" <= 5)::float8 AS avg,
      COUNT(*) FILTER (WHERE "rating" = 1)::int AS s1,
      COUNT(*) FILTER (WHERE "rating" = 2)::int AS s2,
      COUNT(*) FILTER (WHERE "rating" = 3)::int AS s3,
      COUNT(*) FILTER (WHERE "rating" = 4)::int AS s4,
      COUNT(*) FILTER (WHERE "rating" = 5)::int AS s5
    FROM "Reservation"
    WHERE ${where}
  `
  const r = rows[0]
  const distribution = [r?.s1 ?? 0, r?.s2 ?? 0, r?.s3 ?? 0, r?.s4 ?? 0, r?.s5 ?? 0]
  return {
    count: r?.cnt ?? 0,
    average: r?.avg === null || r?.avg === undefined ? null : round1(r.avg),
    distribution,
  }
}

interface SqlGroupRow {
  key: string | null
  cnt: number
  completed: number
  cancelled: number
  noShow: number
  walkIn: number
  online: number
  waitCount: number
  waitSumMinutes: number
  svcCount: number
  svcSumMinutes: number
}

function groupRowsToStats(rows: SqlGroupRow[]): GroupReservationStats[] {
  // Engine parity (groupReservationStats): rows whose key is null are skipped.
  const out: GroupReservationStats[] = []
  for (const r of rows) {
    if (r.key === null || r.key === undefined) continue
    const waitCount = Number(r.waitCount ?? 0)
    const svcCount = Number(r.svcCount ?? 0)
    out.push({
      key: String(r.key),
      count: Number(r.cnt ?? 0),
      completed: Number(r.completed ?? 0),
      cancelled: Number(r.cancelled ?? 0),
      noShow: Number(r.noShow ?? 0),
      walkIn: Number(r.walkIn ?? 0),
      online: Number(r.online ?? 0),
      completionRate: Number(r.cnt ?? 0) > 0 ? rateOf(Number(r.completed ?? 0), Number(r.cnt ?? 0)) : 0,
      avgWaitMinutes: waitCount > 0 ? round1(Number(r.waitSumMinutes ?? 0) / waitCount) : null,
      avgServiceMinutes: svcCount > 0 ? round1(Number(r.svcSumMinutes ?? 0) / svcCount) : null,
    })
  }
  return out
}

const GROUP_AGGREGATES_SQL = Prisma.raw(`
      COUNT(*)::int AS cnt,
      COUNT(*) FILTER (WHERE "status" = 'COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE "status" = 'CANCELLED')::int AS cancelled,
      COUNT(*) FILTER (WHERE "status" = 'NO_SHOW')::int AS "noShow",
      COUNT(*) FILTER (WHERE "isWalkIn")::int AS "walkIn",
      COUNT(*) FILTER (WHERE NOT "isWalkIn" AND "userId" IS NOT NULL)::int AS "online",
      COUNT(*) FILTER (WHERE "calledAt" IS NOT NULL)::int AS "waitCount",
      COALESCE(SUM(CASE WHEN "calledAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("calledAt" - "joinedAt")) / 60.0 END), 0)::float8 AS "waitSumMinutes",
      COUNT(*) FILTER (WHERE "calledAt" IS NOT NULL AND "completedAt" IS NOT NULL)::int AS "svcCount",
      COALESCE(SUM(CASE WHEN "calledAt" IS NOT NULL AND "completedAt" IS NOT NULL THEN EXTRACT(EPOCH FROM ("completedAt" - "calledAt")) / 60.0 END), 0)::float8 AS "svcSumMinutes"`)

/**
 * SQL twin of groupReservationStats(rows, keyOf) for the owner analytics
 * groupings. 'branchId' resolves the branch THROUGH the serving counter
 * (inner join) — exactly the rows the JS keyOf kept (unknown/null counter →
 * skipped). Names are still resolved by the route's lookup maps.
 */
export async function sqlReservationGroupStats(
  agencyId: string,
  rangeStart: Date,
  rangeEnd: Date,
  dim: 'serviceId' | 'counterId' | 'branchId',
  filters: OwnerAnalyticsFilters = {},
): Promise<GroupReservationStats[]> {
  const where = buildOwnerWhere(agencyId, rangeStart, rangeEnd, filters)
  if (dim === 'branchId') {
    const rows = await db.$queryRaw<SqlGroupRow[]>`
      SELECT c."branchId" AS key, ${GROUP_AGGREGATES_SQL}
      FROM "Reservation" r
      JOIN "Counter" c ON c."id" = r."counterId"
      WHERE ${where}
      GROUP BY c."branchId"
    `
    return groupRowsToStats(rows)
  }
  const dimCol = dim === 'serviceId' ? Prisma.raw(`"serviceId"`) : Prisma.raw(`"counterId"`)
  const rows = await db.$queryRaw<SqlGroupRow[]>`
    SELECT ${dimCol} AS key, ${GROUP_AGGREGATES_SQL}
    FROM "Reservation"
    WHERE ${where}
    GROUP BY 1
  `
  return groupRowsToStats(rows)
}
