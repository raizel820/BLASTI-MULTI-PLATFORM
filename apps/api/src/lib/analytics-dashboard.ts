// ─── analytics-dashboard.ts (Task 3 — shared analytics engine) ───────────────
//
// Shared computation behind:
//   - GET /api/agency/analytics/dashboard (agency.ts — caller's own agency)
//   - GET /api/admin/analytics/dashboard  (admin.ts — global / per-active-agency average)
//   - GET /api/admin/analytics/agency/:agencyId (admin.ts — any single agency)
//
// ALL bucketing/math is UTC. Semantics (unchanged from the original Task 42-b
// endpoint — the desktop local API mirrors this shape; change both or neither):
//   - end = now; 7d/30d/90d → start = end − N×24h; 12m → 00:00 UTC of the
//     month 11 months before the current month (12 calendar months incl. current)
//   - previous period = [start − length, start)
//   - every count is keyed on joinedAt falling in the range (current status)
//   - avgWaitMinutes   = mean(calledAt − joinedAt)     over rows that have calledAt
//   - avgServiceMinutes = mean(completedAt − calledAt) over rows that have both
//   - walkIn = isWalkIn true; online = !isWalkIn AND userId != null (same
//     convention as GET /agency/stats)
//   - uniqueCustomers = distinct non-null userId (walk-ins carry no account)
//   - rates are 0–100 with one decimal (0 when total = 0); durations/ratings
//     one decimal or null when there is no data
//   - deltas vs previous period: count/duration metrics are percent change
//     (null when previous is 0/none); noShowRate is a percentage-point delta
//   - timeseries buckets: calendar days (UTC) from start to end for 7d/30d/90d,
//     calendar months for 12m — every bucket present, zero-filled
// Implementation: ONE findMany for the current range + one for the previous
// range, aggregated in JS; Service/Branch/Counter names via lookup maps.
//
// Task 3 additions (ADDITIVE — older consumers ignore unknown keys safely):
//   - kpis.walkInRate / kpis.onlineRate (0–100, one decimal, share of total,
//     0 when total = 0)
//   - every timeseries point carries `walkIn` and `online` counts
//   - `channel` block: { onlineCount, walkInCount, total, onlineRate,
//     walkInRate, daily: [{ date, online, walkIn }] } — daily uses the SAME
//     bucketing as timeseries (daily for 7d/30d/90d, monthly for 12m)
//   - agencyId === null (GLOBAL mode): no agency filter on reservations;
//     branches/counters are empty arrays; services aggregate across ALL
//     agencies (names resolved from the platform-wide Service table)

import { db } from '@blasti/db'

/** One-decimal rounding. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Percent change of cur vs prev — null when previous is 0/none or cur missing. */
export function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null
  return round1(((cur - prev) / prev) * 100)
}

/** 'YYYY-MM-DD' (UTC). */
export function utcDateKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 'YYYY-MM' (UTC). */
export function utcMonthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export const DASHBOARD_PERIODS = ['7d', '30d', '90d', '12m'] as const
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number]

// ─── Task 54-a — Shared period engine (doc-2 spec §3.1) ─────────────────────
//
// ONE resolver for every analytics endpoint that accepts `period`:
//   today, yesterday, 7d, 30d, 90d, 12m, this-week, last-week, this-month,
//   last-month, this-quarter, last-quarter, this-year, last-year, custom
//
// Backward compatibility:
//   - 7d/30d produce EXACTLY the same [start,end) as the legacy engine math
//     (end = now, start = end − N×24h); 90d and 12m are accepted directly
//     (90d→90d, 12m→rolling 12 calendar months incl. current — the same
//     definition the existing dashboard uses).
//   - The legacy routes keep using DASHBOARD_PERIODS/computeAnalyticsDashboard
//     untouched; new routes use resolvePeriodRange.
//
// All math is UTC. `end` for LIVE windows (today, 7d/30d/90d, 12m, this-*)
// is `now`; fixed windows in the past (yesterday, last-*) end at 23:59:59.999
// of their last day. previousStart/previousEnd cover the immediately preceding
// window of the same length (for fixed past windows this is the preceding
// calendar twin; for live windows it is [start − length, start), matching the
// legacy delta convention).
//
// Granularity follows spec §52: today/yesterday → hourly; week/30d/7d/90d →
// daily; month/quarter/year/12m → monthly; custom → daily up to 92 days,
// monthly beyond.

/** 'YYYY-MM-DDTHH' (UTC) — hourly bucket key. */
export function utcHourKey(d: Date): string {
  return `${utcDateKey(d)}T${String(d.getUTCHours()).padStart(2, '0')}`
}

export const ANALYTICS_PERIODS = [
  'today',
  'yesterday',
  '7d',
  '30d',
  '90d',
  '12m',
  'this-week',
  'last-week',
  'this-month',
  'last-month',
  'this-quarter',
  'last-quarter',
  'this-year',
  'last-year',
  'custom',
] as const

export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number]

export type AnalyticsGranularity = 'hourly' | 'daily' | 'monthly'

export interface ResolvedPeriodRange {
  period: AnalyticsPeriod
  /** Inclusive window start (UTC). */
  start: Date
  /** Inclusive window end — `now` for live windows. */
  end: Date
  previousStart: Date
  previousEnd: Date
  granularity: AnalyticsGranularity
  /** Ordered, zero-fillable bucket keys ('YYYY-MM-DDTHH' | 'YYYY-MM-DD' | 'YYYY-MM'). */
  bucketKeys: string[]
  /** ISO echoes for the UI label (spec §3.1 — the payload carries its window). */
  from: string
  to: string
}

function isIsoDateString(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v.trim())
}

/** Parse a from/to pair for `custom`. Date-only values expand to full UTC days. */
function parseCustomBounds(fromRaw: string, toRaw: string): { start: Date; end: Date } {
  if (!isIsoDateString(fromRaw) || !isIsoDateString(toRaw)) {
    throw new Error('PERIOD_INVALID: custom requires ISO from and to (YYYY-MM-DD or full timestamp)')
  }
  const fromOnly = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw.trim())
  const toOnly = /^\d{4}-\d{2}-\d{2}$/.test(toRaw.trim())
  const start = new Date(fromRaw.trim().replace(' ', 'T'))
  const end = new Date(toRaw.trim().replace(' ', 'T'))
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('PERIOD_INVALID: from/to are not valid dates')
  }
  if (fromOnly) start.setUTCHours(0, 0, 0, 0)
  if (toOnly) end.setUTCHours(23, 59, 59, 999)
  if (end.getTime() < start.getTime()) {
    throw new Error('PERIOD_INVALID: to must not be before from')
  }
  return { start, end }
}

/** Ordered zero-fill bucket keys for a resolved range at its granularity. */
function buildBucketKeys(start: Date, end: Date, granularity: AnalyticsGranularity): string[] {
  const keys: string[] = []
  if (granularity === 'hourly') {
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), start.getUTCHours()))
    while (cursor.getTime() <= end.getTime()) {
      keys.push(utcHourKey(cursor))
      cursor.setUTCHours(cursor.getUTCHours() + 1)
    }
  } else if (granularity === 'daily') {
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
    while (cursor.getTime() <= end.getTime()) {
      keys.push(utcDateKey(cursor))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  } else {
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
    while (cursor.getTime() <= end.getTime()) {
      keys.push(utcMonthKey(cursor))
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
  }
  return keys
}

function granularityFor(period: AnalyticsPeriod, start: Date, end: Date): AnalyticsGranularity {
  if (period === 'today' || period === 'yesterday') return 'hourly'
  if (period === 'this-week' || period === 'last-week' || period === '7d' || period === '30d' || period === '90d') return 'daily'
  if (period === 'custom') {
    const daySpanMs = 92 * 24 * 60 * 60 * 1000
    return end.getTime() - start.getTime() <= daySpanMs ? 'daily' : 'monthly'
  }
  return 'monthly'
}

/** Monday 00:00 UTC of the week containing `d`. */
function startOfUtcWeek(d: Date): Date {
  const day = d.getUTCDay() // 0 = Sunday
  const backToMonday = (day + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - backToMonday, 0, 0, 0, 0))
}

function startOfUtcQuarter(d: Date): Date {
  const quarterMonth = Math.floor(d.getUTCMonth() / 3) * 3
  return new Date(Date.UTC(d.getUTCFullYear(), quarterMonth, 1, 0, 0, 0, 0))
}

/**
 * Resolve any doc-2 §3.1 period (or `custom` with from/to) to a concrete UTC
 * window + previous window + granularity + zero-fill bucket keys.
 * Throws `Error('PERIOD_INVALID: …')` for bad input — route helpers turn that
 * into a 400 response.
 */
export function resolvePeriodRange(
  period: AnalyticsPeriod,
  from?: string | null,
  to?: string | null,
): ResolvedPeriodRange {
  const now = new Date()
  let start: Date
  let end: Date
  let prevStart: Date
  let prevEnd: Date

  switch (period) {
    case 'today': {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))
      end = now
      const lengthMs = Math.max(end.getTime() - start.getTime(), 1)
      prevStart = new Date(start.getTime() - lengthMs)
      prevEnd = start
      break
    }
    case 'yesterday': {
      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0))
      const dayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 23, 59, 59, 999))
      start = dayStart
      end = dayEnd
      prevStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000)
      prevEnd = new Date(dayEnd.getTime() - 24 * 60 * 60 * 1000)
      break
    }
    case '7d':
    case '30d':
    case '90d': {
      // EXACT legacy math (computeAnalyticsDashboard) so both engines agree.
      const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
      end = now
      start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
      prevStart = new Date(start.getTime() - days * 24 * 60 * 60 * 1000)
      prevEnd = start
      break
    }
    case '12m': {
      // EXACT legacy math: 00:00 UTC of the month 11 months before current.
      end = now
      start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1, 0, 0, 0, 0))
      prevStart = new Date(start.getTime() - (end.getTime() - start.getTime()))
      prevEnd = start
      break
    }
    case 'this-week': {
      start = startOfUtcWeek(now)
      end = now
      const lengthMs = Math.max(end.getTime() - start.getTime(), 1)
      prevStart = new Date(start.getTime() - lengthMs)
      prevEnd = start
      break
    }
    case 'last-week': {
      const weekStart = startOfUtcWeek(now)
      start = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000)
      end = new Date(weekStart.getTime() - 1)
      prevStart = new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000)
      prevEnd = new Date(start.getTime() - 1)
      break
    }
    case 'this-month': {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
      end = now
      const lengthMs = Math.max(end.getTime() - start.getTime(), 1)
      prevStart = new Date(start.getTime() - lengthMs)
      prevEnd = start
      break
    }
    case 'last-month': {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0))
      end = new Date(monthStart.getTime() - 1)
      prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1, 0, 0, 0, 0))
      prevEnd = new Date(start.getTime() - 1)
      break
    }
    case 'this-quarter': {
      start = startOfUtcQuarter(now)
      end = now
      const lengthMs = Math.max(end.getTime() - start.getTime(), 1)
      prevStart = new Date(start.getTime() - lengthMs)
      prevEnd = start
      break
    }
    case 'last-quarter': {
      const quarterStart = startOfUtcQuarter(now)
      start = new Date(Date.UTC(quarterStart.getUTCFullYear(), quarterStart.getUTCMonth() - 3, 1, 0, 0, 0, 0))
      end = new Date(quarterStart.getTime() - 1)
      prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 3, 1, 0, 0, 0, 0))
      prevEnd = new Date(start.getTime() - 1)
      break
    }
    case 'this-year': {
      start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0))
      end = now
      const lengthMs = Math.max(end.getTime() - start.getTime(), 1)
      prevStart = new Date(start.getTime() - lengthMs)
      prevEnd = start
      break
    }
    case 'last-year': {
      const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0))
      start = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1, 0, 0, 0, 0))
      end = new Date(yearStart.getTime() - 1)
      prevStart = new Date(Date.UTC(now.getUTCFullYear() - 2, 0, 1, 0, 0, 0, 0))
      prevEnd = new Date(start.getTime() - 1)
      break
    }
    case 'custom': {
      if (!from || !to) {
        throw new Error('PERIOD_INVALID: custom requires both from and to')
      }
      const bounds = parseCustomBounds(from, to)
      start = bounds.start
      end = bounds.end
      const lengthMs = end.getTime() - start.getTime()
      prevStart = new Date(start.getTime() - lengthMs)
      prevEnd = start
      break
    }
    default:
      throw new Error('PERIOD_INVALID: unknown period')
  }

  const granularity = granularityFor(period, start, end)
  const bucketKeys = buildBucketKeys(start, end, granularity)

  return {
    period,
    start,
    end,
    previousStart: prevStart,
    previousEnd: prevEnd,
    granularity,
    bucketKeys,
    from: start.toISOString(),
    to: end.toISOString(),
  }
}

/** Parse the `period` query param against ANALYTICS_PERIODS with a fallback. */
export function parseAnalyticsPeriod(raw: string | undefined, fallback: AnalyticsPeriod = '30d'): AnalyticsPeriod {
  if (!raw) return fallback
  return (ANALYTICS_PERIODS as readonly string[]).includes(raw) ? (raw as AnalyticsPeriod) : fallback
}

export interface AnalyticsDashboardPayload {
  period: DashboardPeriod
  generatedAt: string
  range: { start: string; end: string; previousStart: string; previousEnd: string }
  kpis: {
    total: number
    completed: number
    cancelled: number
    noShow: number
    completionRate: number
    cancellationRate: number
    noShowRate: number
    avgWaitMinutes: number | null
    avgServiceMinutes: number | null
    avgRating: number | null
    ratingCount: number
    walkInCount: number
    onlineCount: number
    walkInRate: number
    onlineRate: number
    uniqueCustomers: number
    deltas: {
      total: number | null
      completed: number | null
      noShowRate: number
      avgWaitMinutes: number | null
      avgRating: number | null
      uniqueCustomers: number | null
    }
  }
  timeseries: Array<{
    date: string
    total: number
    completed: number
    cancelled: number
    noShow: number
    avgWaitMinutes: number | null
    walkIn: number
    online: number
  }>
  statusDistribution: Array<{ status: string; count: number }>
  hourlyTraffic: Array<{ hour: number; count: number }>
  weekdayHourMatrix: Array<{ weekday: number; hour: number; count: number }>
  services: Array<{
    serviceId: string
    name: string
    count: number
    completed: number
    cancelled: number
    noShow: number
    completionRate: number
    avgWaitMinutes: number | null
  }>
  branches: Array<{
    branchId: string | null
    name: string
    count: number
    completed: number
    noShowRate: number
    avgWaitMinutes: number | null
  }>
  counters: Array<{
    counterId: string
    name: string
    branchName: string
    served: number
    avgServiceMinutes: number | null
  }>
  ratings: {
    distribution: Array<{ stars: number; count: number }>
    average: number | null
    count: number
  }
  peak: { busiestHour: number | null; busiestWeekday: number | null; busiestDay: string | null }
  channel: {
    onlineCount: number
    walkInCount: number
    total: number
    onlineRate: number
    walkInRate: number
    daily: Array<{ date: string; online: number; walkIn: number }>
  }
}

export interface ComputeAnalyticsDashboardOptions {
  /** Agency to scope the computation to — null = GLOBAL (all agencies). */
  agencyId: string | null
  period: DashboardPeriod
}

/**
 * Compute the consolidated analytics dashboard payload.
 *
 * agencyId = string → per-agency mode (branches/counters included).
 * agencyId = null   → GLOBAL mode: no agency filter, empty branches/counters,
 *                     services aggregated platform-wide.
 */
export async function computeAnalyticsDashboard(
  opts: ComputeAnalyticsDashboardOptions,
): Promise<AnalyticsDashboardPayload> {
  const { agencyId, period } = opts
  const isGlobal = agencyId === null

  // ── Range math (UTC) ────────────────────────────────────────────────────────
  const end = new Date()
  let start: Date
  if (period === '12m') {
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1, 0, 0, 0, 0))
  } else {
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
    start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
  }
  const lengthMs = end.getTime() - start.getTime()
  const previousStart = new Date(start.getTime() - lengthMs)
  const previousEnd = start

  // ── Fetch: current + previous ranges, then lookup maps ─────────────────────
  const reservationSelect = {
    status: true,
    joinedAt: true,
    calledAt: true,
    completedAt: true,
    cancelledAt: true,
    rating: true,
    isWalkIn: true,
    userId: true,
    serviceId: true,
    counterId: true,
  } as const

  const agencyScope = isGlobal ? {} : { agencyId }

  const [reservations, previousRows, serviceRows, branchRows, counterRows] = await Promise.all([
    db.reservation.findMany({
      where: { ...agencyScope, joinedAt: { gte: start, lte: end } },
      select: reservationSelect,
    }),
    db.reservation.findMany({
      where: { ...agencyScope, joinedAt: { gte: previousStart, lt: previousEnd } },
      select: {
        status: true,
        joinedAt: true,
        calledAt: true,
        rating: true,
        userId: true,
      },
    }),
    // GLOBAL mode: names resolved from the platform-wide Service table.
    // Agency mode: names from this agency's services only (legacy behavior).
    isGlobal
      ? db.service.findMany({ select: { id: true, name: true } })
      : db.service.findMany({ where: { agencyId: agencyId as string }, select: { id: true, name: true } }),
    // Branch/counter lookups are meaningless globally → skipped (empty arrays).
    isGlobal
      ? Promise.resolve([] as Array<{ id: string; name: string }>)
      : db.branch.findMany({ where: { agencyId: agencyId as string }, select: { id: true, name: true } }),
    isGlobal
      ? Promise.resolve([] as Array<{ id: string; name: string; branchId: string; branch: { name: string } }>)
      : db.counter.findMany({
          where: { branch: { agencyId: agencyId as string } },
          select: { id: true, name: true, branchId: true, branch: { select: { name: true } } },
        }),
  ])

  const serviceNames = new Map(serviceRows.map((s) => [s.id, s.name]))
  const branchNames = new Map(branchRows.map((b) => [b.id, b.name]))
  const counterInfos = new Map(counterRows.map((ct) => [ct.id, { name: ct.name, branchId: ct.branchId, branchName: ct.branch.name }]))

  // ── Current-range aggregation ───────────────────────────────────────────────
  let total = 0
  let completed = 0
  let cancelled = 0
  let noShow = 0
  let ratingSum = 0
  let ratingCount = 0
  let walkInCount = 0
  let onlineCount = 0
  let waitSumMs = 0
  let waitCount = 0
  let serviceSumMs = 0
  let serviceCount = 0
  const uniqueCustomerIds = new Set<string>()

  const statusCounts: Record<string, number> = {
    WAITING: 0,
    CALLED: 0,
    SERVING: 0,
    COMPLETED: 0,
    CANCELLED: 0,
    NO_SHOW: 0,
  }
  const hourlyCounts = new Array<number>(24).fill(0)
  const weekdayCounts = new Array<number>(7).fill(0)
  const weekdayHourCounts = new Map<string, number>()
  const dailyTotals = new Map<string, number>() // busiestDay (always daily granularity)
  const ratingDist = [0, 0, 0, 0, 0] // index 0 → 1 star

  interface TsBucket { total: number; completed: number; cancelled: number; noShow: number; walkIn: number; online: number; waitSumMs: number; waitCount: number }
  const tsBuckets = new Map<string, TsBucket>()
  const daily = period === '12m'
  if (daily) {
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
    const lastKey = utcMonthKey(end)
    while (utcMonthKey(cursor) <= lastKey) {
      tsBuckets.set(utcMonthKey(cursor), { total: 0, completed: 0, cancelled: 0, noShow: 0, walkIn: 0, online: 0, waitSumMs: 0, waitCount: 0 })
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
  } else {
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
    const lastKey = utcDateKey(end)
    while (utcDateKey(cursor) <= lastKey) {
      tsBuckets.set(utcDateKey(cursor), { total: 0, completed: 0, cancelled: 0, noShow: 0, walkIn: 0, online: 0, waitSumMs: 0, waitCount: 0 })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }

  interface ServiceAgg { count: number; completed: number; cancelled: number; noShow: number; waitSumMs: number; waitCount: number }
  const serviceAggs = new Map<string, ServiceAgg>()
  interface BranchAgg { count: number; completed: number; noShow: number; waitSumMs: number; waitCount: number }
  const branchAggs = new Map<string, BranchAgg>() // key: branchId or '' for null
  interface CounterAgg { served: number; serviceSumMs: number; serviceCount: number }
  const counterAggs = new Map<string, CounterAgg>()

  for (const r of reservations) {
    total++
    if (r.status === 'COMPLETED') completed++
    if (r.status === 'CANCELLED') cancelled++
    if (r.status === 'NO_SHOW') noShow++
    if (r.status in statusCounts) statusCounts[r.status]++

    if (r.isWalkIn) walkInCount++
    else if (r.userId) onlineCount++
    if (r.userId) uniqueCustomerIds.add(r.userId)

    if (r.rating !== null && r.rating >= 1 && r.rating <= 5) {
      ratingSum += r.rating
      ratingCount++
      ratingDist[r.rating - 1]++
    }

    if (r.calledAt) {
      waitSumMs += r.calledAt.getTime() - r.joinedAt.getTime()
      waitCount++
    }
    if (r.calledAt && r.completedAt) {
      serviceSumMs += r.completedAt.getTime() - r.calledAt.getTime()
      serviceCount++
    }

    // Timeseries bucket by joinedAt
    const bucketKey = daily ? utcMonthKey(r.joinedAt) : utcDateKey(r.joinedAt)
    const bucket = tsBuckets.get(bucketKey)
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
    dailyTotals.set(utcDateKey(r.joinedAt), (dailyTotals.get(utcDateKey(r.joinedAt)) || 0) + 1)

    // Hourly / weekday / matrix (UTC; 0 = Sunday)
    const hour = r.joinedAt.getUTCHours()
    const weekday = r.joinedAt.getUTCDay()
    hourlyCounts[hour]++
    weekdayCounts[weekday]++
    const whKey = `${weekday}-${hour}`
    weekdayHourCounts.set(whKey, (weekdayHourCounts.get(whKey) || 0) + 1)

    // Services
    const svc = serviceAggs.get(r.serviceId) || { count: 0, completed: 0, cancelled: 0, noShow: 0, waitSumMs: 0, waitCount: 0 }
    svc.count++
    if (r.status === 'COMPLETED') svc.completed++
    if (r.status === 'CANCELLED') svc.cancelled++
    if (r.status === 'NO_SHOW') svc.noShow++
    if (r.calledAt) {
      svc.waitSumMs += r.calledAt.getTime() - r.joinedAt.getTime()
      svc.waitCount++
    }
    serviceAggs.set(r.serviceId, svc)

    // Branches (via counterId → Counter.branchId; '' = no counter) — skipped in
    // GLOBAL mode (no counter/branch context is fetched there).
    if (!isGlobal) {
      const counterInfo = r.counterId ? counterInfos.get(r.counterId) : undefined
      const branchKey = counterInfo ? counterInfo.branchId : ''
      const br = branchAggs.get(branchKey) || { count: 0, completed: 0, noShow: 0, waitSumMs: 0, waitCount: 0 }
      br.count++
      if (r.status === 'COMPLETED') br.completed++
      if (r.status === 'NO_SHOW') br.noShow++
      if (r.calledAt) {
        br.waitSumMs += r.calledAt.getTime() - r.joinedAt.getTime()
        br.waitCount++
      }
      branchAggs.set(branchKey, br)

      // Counters
      if (r.counterId) {
        const ctag = counterAggs.get(r.counterId) || { served: 0, serviceSumMs: 0, serviceCount: 0 }
        if (r.status === 'COMPLETED') ctag.served++
        if (r.calledAt && r.completedAt) {
          ctag.serviceSumMs += r.completedAt.getTime() - r.calledAt.getTime()
          ctag.serviceCount++
        }
        counterAggs.set(r.counterId, ctag)
      }
    }
  }

  // ── KPIs ────────────────────────────────────────────────────────────────────
  const completionRate = total > 0 ? round1((completed / total) * 100) : 0
  const cancellationRate = total > 0 ? round1((cancelled / total) * 100) : 0
  const noShowRate = total > 0 ? round1((noShow / total) * 100) : 0
  const avgWaitMinutes = waitCount > 0 ? round1(waitSumMs / waitCount / 60000) : null
  const avgServiceMinutes = serviceCount > 0 ? round1(serviceSumMs / serviceCount / 60000) : null
  const avgRating = ratingCount > 0 ? round1(ratingSum / ratingCount) : null
  const uniqueCustomers = uniqueCustomerIds.size
  const walkInRate = total > 0 ? round1((walkInCount / total) * 100) : 0
  const onlineRate = total > 0 ? round1((onlineCount / total) * 100) : 0

  // ── Previous-period KPIs (for deltas) ───────────────────────────────────────
  let prevTotal = 0
  let prevCompleted = 0
  let prevNoShow = 0
  let prevWaitSumMs = 0
  let prevWaitCount = 0
  let prevRatingSum = 0
  let prevRatingCount = 0
  const prevUniqueIds = new Set<string>()
  for (const r of previousRows) {
    prevTotal++
    if (r.status === 'COMPLETED') prevCompleted++
    if (r.status === 'NO_SHOW') prevNoShow++
    if (r.calledAt) {
      prevWaitSumMs += r.calledAt.getTime() - r.joinedAt.getTime()
      prevWaitCount++
    }
    if (r.rating !== null && r.rating >= 1 && r.rating <= 5) {
      prevRatingSum += r.rating
      prevRatingCount++
    }
    if (r.userId) prevUniqueIds.add(r.userId)
  }
  const prevNoShowRate = prevTotal > 0 ? round1((prevNoShow / prevTotal) * 100) : 0
  const prevAvgWaitMinutes = prevWaitCount > 0 ? round1(prevWaitSumMs / prevWaitCount / 60000) : null
  const prevAvgRating = prevRatingCount > 0 ? round1(prevRatingSum / prevRatingCount) : null
  const prevUniqueCustomers = prevUniqueIds.size

  // ── Assemble output sections ────────────────────────────────────────────────
  const timeseries = Array.from(tsBuckets.entries()).map(([date, b]) => ({
    date,
    total: b.total,
    completed: b.completed,
    cancelled: b.cancelled,
    noShow: b.noShow,
    avgWaitMinutes: b.waitCount > 0 ? round1(b.waitSumMs / b.waitCount / 60000) : null,
    walkIn: b.walkIn,
    online: b.online,
  }))

  const statusDistribution = Object.entries(statusCounts).map(([status, count]) => ({ status, count }))

  const hourlyTraffic = hourlyCounts.map((count, hour) => ({ hour, count }))

  const weekdayHourMatrix = Array.from(weekdayHourCounts.entries())
    .map(([key, count]) => {
      const [weekday, hour] = key.split('-').map((v) => parseInt(v, 10))
      return { weekday, hour, count }
    })
    .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour)

  const services = Array.from(serviceAggs.entries())
    .map(([serviceId, s]) => ({
      serviceId,
      name: serviceNames.get(serviceId) ?? 'Unknown',
      count: s.count,
      completed: s.completed,
      cancelled: s.cancelled,
      noShow: s.noShow,
      completionRate: round1((s.completed / s.count) * 100),
      avgWaitMinutes: s.waitCount > 0 ? round1(s.waitSumMs / s.waitCount / 60000) : null,
    }))
    .sort((a, b) => b.count - a.count || a.serviceId.localeCompare(b.serviceId))

  const branches = isGlobal
    ? []
    : Array.from(branchAggs.entries())
        .map(([branchKey, b]) => ({
          branchId: branchKey === '' ? null : branchKey,
          name: branchKey === '' ? '—' : (branchNames.get(branchKey) ?? '—'),
          count: b.count,
          completed: b.completed,
          noShowRate: round1((b.noShow / b.count) * 100),
          avgWaitMinutes: b.waitCount > 0 ? round1(b.waitSumMs / b.waitCount / 60000) : null,
        }))
        .sort((a, b) => b.count - a.count || (a.branchId ?? '').localeCompare(b.branchId ?? ''))

  const counters = isGlobal
    ? []
    : Array.from(counterAggs.entries())
        .map(([counterId, ctag]) => {
          const info = counterInfos.get(counterId)
          return {
            counterId,
            name: info?.name ?? 'Unknown counter',
            branchName: info?.branchName ?? '—',
            served: ctag.served,
            avgServiceMinutes: ctag.serviceCount > 0 ? round1(ctag.serviceSumMs / ctag.serviceCount / 60000) : null,
          }
        })
        .sort((a, b) => b.served - a.served || a.counterId.localeCompare(b.counterId))
        .slice(0, 12)

  // ── Peak analysis ───────────────────────────────────────────────────────────
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
    period,
    generatedAt: end.toISOString(),
    range: {
      start: start.toISOString(),
      end: end.toISOString(),
      previousStart: previousStart.toISOString(),
      previousEnd: previousEnd.toISOString(),
    },
    kpis: {
      total,
      completed,
      cancelled,
      noShow,
      completionRate,
      cancellationRate,
      noShowRate,
      avgWaitMinutes,
      avgServiceMinutes,
      avgRating,
      ratingCount,
      walkInCount,
      onlineCount,
      walkInRate,
      onlineRate,
      uniqueCustomers,
      deltas: {
        total: pctChange(total, prevTotal),
        completed: pctChange(completed, prevCompleted),
        noShowRate: round1(noShowRate - prevNoShowRate),
        avgWaitMinutes: pctChange(avgWaitMinutes, prevAvgWaitMinutes),
        avgRating: pctChange(avgRating, prevAvgRating),
        uniqueCustomers: pctChange(uniqueCustomers, prevUniqueCustomers),
      },
    },
    timeseries,
    statusDistribution,
    hourlyTraffic,
    weekdayHourMatrix,
    services,
    branches,
    counters,
    ratings: {
      distribution: ratingDist.map((count, i) => ({ stars: i + 1, count })),
      average: avgRating,
      count: ratingCount,
    },
    peak: {
      busiestHour,
      busiestWeekday,
      busiestDay,
    },
    channel: {
      onlineCount,
      walkInCount,
      total,
      onlineRate,
      walkInRate,
      daily: timeseries.map((t) => ({ date: t.date, online: t.online, walkIn: t.walkIn })),
    },
  }
}
