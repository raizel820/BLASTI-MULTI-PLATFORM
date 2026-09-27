// ─── analytics-engine.ts (Task 54-a — shared aggregation toolkit) ────────────
//
// Doc-2 spec §54: ONE reusable analytics engine, role-specific definitions.
// This module is the JS-side aggregation half of that engine; the period
// half lives in lib/analytics-dashboard.ts (resolvePeriodRange).
//
// Everything here is PURE: it takes already-fetched Prisma rows + a resolved
// range and returns aggregates. Routes do the scoping (User → Permission
// Scope → Allowed Records — spec §4) in their Prisma `where` BEFORE calling
// these helpers; nothing here ever widens a query.
//
// Conventions inherited from lib/analytics-dashboard.ts (do not change):
//   - walkIn  = isWalkIn true
//   - online  = !isWalkIn AND userId != null
//   - wait    = calledAt − joinedAt           (rows with calledAt)
//   - service = completedAt − calledAt        (rows with both)
//   - rates are 0–100 with one decimal (0 when total = 0)
//   - durations/averages are minutes with one decimal, null when no data

import {
  round1,
  utcHourKey,
  utcDateKey,
  utcMonthKey,
  type ResolvedPeriodRange,
  type AnalyticsGranularity,
} from './analytics-dashboard'

// ─── Minimal row shape needed by the aggregators ─────────────────────────────

export interface AggregatableReservation {
  status: string
  joinedAt: Date
  calledAt: Date | null
  completedAt: Date | null
  cancelledAt: Date | null
  rating?: number | null
  isWalkIn: boolean
  userId?: string | null
  serviceId?: string
  counterId?: string | null
  agencyId?: string
}

export const RESERVATION_STATUS_KEYS = [
  'WAITING',
  'CALLED',
  'SERVING',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const

// ─── Small stat helpers ──────────────────────────────────────────────────────

export function mean(nums: number[]): number | null {
  if (nums.length === 0) return null
  return round1(nums.reduce((a, b) => a + b, 0) / nums.length)
}

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const raw = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  return round1(raw)
}

export function maxOf(nums: number[]): number | null {
  if (nums.length === 0) return null
  return round1(Math.max(...nums))
}

export function rateOf(part: number, total: number): number {
  return total > 0 ? round1((part / total) * 100) : 0
}

/** Safe min/max averaging window in hours (≥ 1h) — for "customers/hour". */
export function hoursSpan(start: Date, end: Date): number {
  return Math.max((end.getTime() - start.getTime()) / (1000 * 60 * 60), 1)
}

// ─── Core reservation aggregation ────────────────────────────────────────────

export interface ReservationKpis {
  total: number
  byStatus: Record<string, number>
  completed: number
  cancelled: number
  noShow: number
  waiting: number
  called: number
  serving: number
  completionRate: number
  cancellationRate: number
  noShowRate: number
  walkInCount: number
  onlineCount: number
  walkInRate: number
  onlineRate: number
  uniqueCustomers: number
  avgWaitMinutes: number | null
  medianWaitMinutes: number | null
  maxWaitMinutes: number | null
  avgServiceMinutes: number | null
  medianServiceMinutes: number | null
  maxServiceMinutes: number | null
  customersPerHour: number | null
}

export interface ReservationTimeseriesPoint {
  bucket: string
  total: number
  completed: number
  cancelled: number
  noShow: number
  walkIn: number
  online: number
  avgWaitMinutes: number | null
}

export interface ReservationAggregate {
  kpis: ReservationKpis
  statusDistribution: Array<{ status: string; count: number }>
  timeseries: ReservationTimeseriesPoint[]
  hourlyTraffic: Array<{ hour: number; count: number }>
  weekdayTraffic: Array<{ weekday: number; count: number }>
  peak: { busiestHour: number | null; busiestWeekday: number | null; busiestDay: string | null }
}

interface Bucket {
  total: number
  completed: number
  cancelled: number
  noShow: number
  walkIn: number
  online: number
  waitSumMs: number
  waitCount: number
}

function bucketKeyOf(d: Date, granularity: AnalyticsGranularity): string {
  if (granularity === 'hourly') return utcHourKey(d)
  if (granularity === 'monthly') return utcMonthKey(d)
  return utcDateKey(d)
}

function emptyBucket(): Bucket {
  return { total: 0, completed: 0, cancelled: 0, noShow: 0, walkIn: 0, online: 0, waitSumMs: 0, waitCount: 0 }
}

/**
 * Aggregate a scoped set of reservations over a resolved period range.
 * One pass, zero extra queries.
 */
export function aggregateReservations(
  rows: AggregatableReservation[],
  range: ResolvedPeriodRange,
): ReservationAggregate {
  const { start, end, granularity, bucketKeys } = range

  const buckets = new Map<string, Bucket>()
  for (const key of bucketKeys) buckets.set(key, emptyBucket())

  const byStatus: Record<string, number> = {}
  for (const s of RESERVATION_STATUS_KEYS) byStatus[s] = 0

  let completed = 0
  let cancelled = 0
  let noShow = 0
  let walkInCount = 0
  let onlineCount = 0
  const waitMinutes: number[] = []
  const serviceMinutes: number[] = []
  const uniqueCustomers = new Set<string>()
  const hourlyCounts = new Array<number>(24).fill(0)
  const weekdayCounts = new Array<number>(7).fill(0)
  const dailyTotals = new Map<string, number>()

  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    if (r.status === 'COMPLETED') completed++
    if (r.status === 'CANCELLED') cancelled++
    if (r.status === 'NO_SHOW') noShow++
    if (r.isWalkIn) walkInCount++
    else if (r.userId) onlineCount++
    if (r.userId) uniqueCustomers.add(r.userId)

    if (r.calledAt) {
      const waitMs = r.calledAt.getTime() - r.joinedAt.getTime()
      waitMinutes.push(waitMs / 60000)
    }
    if (r.calledAt && r.completedAt) {
      const svcMs = r.completedAt.getTime() - r.calledAt.getTime()
      serviceMinutes.push(svcMs / 60000)
    }

    const hour = r.joinedAt.getUTCHours()
    const weekday = r.joinedAt.getUTCDay()
    hourlyCounts[hour]++
    weekdayCounts[weekday]++
    const dKey = utcDateKey(r.joinedAt)
    dailyTotals.set(dKey, (dailyTotals.get(dKey) ?? 0) + 1)

    const bKey = bucketKeyOf(r.joinedAt, granularity)
    const bucket = buckets.get(bKey)
    if (bucket) {
      bucket.total++
      if (r.status === 'COMPLETED') bucket.completed++
      if (r.status === 'CANCELLED') bucket.cancelled++
      if (r.status === 'NO_SHOW') bucket.noShow++
      if (r.isWalkIn) bucket.walkIn++
      else if (r.userId) bucket.online++
      if (r.calledAt) {
        bucket.waitSumMs += r.calledAt.getTime() - r.joinedAt.getTime()
        bucket.waitCount++
      }
    }
  }

  const total = rows.length
  const kpis: ReservationKpis = {
    total,
    byStatus,
    completed,
    cancelled,
    noShow,
    waiting: byStatus.WAITING ?? 0,
    called: byStatus.CALLED ?? 0,
    serving: byStatus.SERVING ?? 0,
    completionRate: rateOf(completed, total),
    cancellationRate: rateOf(cancelled, total),
    noShowRate: rateOf(noShow, total),
    walkInCount,
    onlineCount,
    walkInRate: rateOf(walkInCount, total),
    onlineRate: rateOf(onlineCount, total),
    uniqueCustomers: uniqueCustomers.size,
    avgWaitMinutes: mean(waitMinutes),
    medianWaitMinutes: median(waitMinutes),
    maxWaitMinutes: maxOf(waitMinutes),
    avgServiceMinutes: mean(serviceMinutes),
    medianServiceMinutes: median(serviceMinutes),
    maxServiceMinutes: maxOf(serviceMinutes),
    customersPerHour: total > 0 ? round1(total / hoursSpan(start, end)) : null,
  }

  const timeseries: ReservationTimeseriesPoint[] = bucketKeys.map((key) => {
    const b = buckets.get(key) ?? emptyBucket()
    return {
      bucket: key,
      total: b.total,
      completed: b.completed,
      cancelled: b.cancelled,
      noShow: b.noShow,
      walkIn: b.walkIn,
      online: b.online,
      avgWaitMinutes: b.waitCount > 0 ? round1(b.waitSumMs / b.waitCount / 60000) : null,
    }
  })

  let busiestHour: number | null = null
  let busiestHourCount = 0
  hourlyCounts.forEach((count, hour) => {
    if (count > busiestHourCount) {
      busiestHourCount = count
      busiestHour = hour
    }
  })
  let busiestWeekday: number | null = null
  let busiestWeekdayCount = 0
  weekdayCounts.forEach((count, weekday) => {
    if (count > busiestWeekdayCount) {
      busiestWeekdayCount = count
      busiestWeekday = weekday
    }
  })
  let busiestDay: string | null = null
  let busiestDayCount = 0
  for (const [dateKey, count] of dailyTotals) {
    if (count > busiestDayCount) {
      busiestDayCount = count
      busiestDay = dateKey
    }
  }

  return {
    kpis,
    statusDistribution: RESERVATION_STATUS_KEYS.map((status) => ({ status, count: byStatus[status] ?? 0 })),
    timeseries,
    hourlyTraffic: hourlyCounts.map((count, hour) => ({ hour, count })),
    weekdayTraffic: weekdayCounts.map((count, weekday) => ({ weekday, count })),
    peak: { busiestHour, busiestWeekday, busiestDay },
  }
}

// ─── Grouped sub-aggregations (by service / branch / counter / staff / etc.) ─

export interface GroupReservationStats {
  key: string
  count: number
  completed: number
  cancelled: number
  noShow: number
  walkIn: number
  online: number
  completionRate: number
  avgWaitMinutes: number | null
  avgServiceMinutes: number | null
}

/**
 * Group the same rows by an arbitrary string key (serviceId, counterId,
 * resolved branchId, staffId, agencyId…). Returns stats per key, unsorted.
 */
export function groupReservationStats(
  rows: Array<AggregatableReservation & { _groupKey?: string | null }>,
  keyOf: (r: AggregatableReservation) => string | null | undefined,
): GroupReservationStats[] {
  interface Acc {
    count: number
    completed: number
    cancelled: number
    noShow: number
    walkIn: number
    online: number
    waitMs: number
    waitCount: number
    svcMs: number
    svcCount: number
  }
  const accs = new Map<string, Acc>()
  for (const r of rows) {
    const key = keyOf(r)
    if (key === null || key === undefined) continue
    const acc = accs.get(key) ?? { count: 0, completed: 0, cancelled: 0, noShow: 0, walkIn: 0, online: 0, waitMs: 0, waitCount: 0, svcMs: 0, svcCount: 0 }
    acc.count++
    if (r.status === 'COMPLETED') acc.completed++
    if (r.status === 'CANCELLED') acc.cancelled++
    if (r.status === 'NO_SHOW') acc.noShow++
    if (r.isWalkIn) acc.walkIn++
    else if (r.userId) acc.online++
    if (r.calledAt) {
      acc.waitMs += r.calledAt.getTime() - r.joinedAt.getTime()
      acc.waitCount++
    }
    if (r.calledAt && r.completedAt) {
      acc.svcMs += r.completedAt.getTime() - r.calledAt.getTime()
      acc.svcCount++
    }
    accs.set(key, acc)
  }
  return Array.from(accs.entries()).map(([key, a]) => ({
    key,
    count: a.count,
    completed: a.completed,
    cancelled: a.cancelled,
    noShow: a.noShow,
    walkIn: a.walkIn,
    online: a.online,
    completionRate: rateOf(a.completed, a.count),
    avgWaitMinutes: a.waitCount > 0 ? round1(a.waitMs / a.waitCount / 60000) : null,
    avgServiceMinutes: a.svcCount > 0 ? round1(a.svcMs / a.svcCount / 60000) : null,
  }))
}

// ─── Rating aggregation ──────────────────────────────────────────────────────

export interface RatingAggregate {
  count: number
  average: number | null
  distribution: Array<{ stars: number; count: number }>
  withResponse: number
  responseRate: number
}

export function aggregateRatings(
  rows: Array<{ rating: number | null; replyText?: string | null }>,
): RatingAggregate {
  const dist = [0, 0, 0, 0, 0]
  let count = 0
  let sum = 0
  let withResponse = 0
  for (const r of rows) {
    if (r.rating !== null && r.rating >= 1 && r.rating <= 5) {
      dist[r.rating - 1]++
      count++
      sum += r.rating
    }
    if (r.replyText !== null && r.replyText !== undefined && r.replyText !== '') withResponse++
  }
  return {
    count,
    average: count > 0 ? round1(sum / count) : null,
    distribution: dist.map((c, i) => ({ stars: i + 1, count: c })),
    withResponse,
    responseRate: rateOf(withResponse, rows.length),
  }
}

// ─── Route-level helpers ─────────────────────────────────────────────────────

import type { Context } from 'hono'
import {
  parseAnalyticsPeriod,
  resolvePeriodRange,
  type AnalyticsPeriod,
  // ResolvedPeriodRange is already imported at the top of this file.
} from './analytics-dashboard'

export interface PeriodQueryResult {
  ok: true
  period: AnalyticsPeriod
  range: ResolvedPeriodRange
}

export interface PeriodQueryError {
  ok: false
  message: string
}

/**
 * Parse `period` (+ `from`/`to` for custom) off the request query.
 * Unknown period names fall back to `fallback` (legacy-safe); a malformed
 * custom range is a 400.
 */
export function resolvePeriodFromQuery(
  c: Context,
  fallback: AnalyticsPeriod = '30d',
): PeriodQueryResult | PeriodQueryError {
  const period = parseAnalyticsPeriod(c.req.query('period'), fallback)
  try {
    const range = resolvePeriodRange(period, c.req.query('from'), c.req.query('to'))
    return { ok: true, period, range }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Invalid period' }
  }
}

/** The resolved-window block every new analytics payload carries (spec §3.1). */
export function resolvedWindowPayload(range: ResolvedPeriodRange) {
  return {
    period: range.period,
    granularity: range.granularity,
    from: range.from,
    to: range.to,
    previousFrom: range.previousStart.toISOString(),
    previousTo: range.previousEnd.toISOString(),
  }
}

/** Prisma where fragment for the resolved window keyed on a date field. */
export function windowWhere(range: ResolvedPeriodRange, field: string = 'joinedAt') {
  return {
    [field]: { gte: range.start, lte: range.end },
  }
}
