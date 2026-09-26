'use client';

// ─── Task 42-e: Agency Analytics & Statistics — API contract types ──────────
//
// Mirrors GET /api/agency/analytics/dashboard?period=7d|30d|90d|12m (identical
// shape on the cloud API and the desktop local API — built in parallel for
// Tasks 42-b/42-c). All numeric fields arrive as numbers; null is only used
// where the contract explicitly allows it (averages with no data, deltas with
// no previous period).

export type AnalyticsPeriod = '7d' | '30d' | '90d' | '12m';

export const ANALYTICS_PERIODS: AnalyticsPeriod[] = ['7d', '30d', '90d', '12m'];

export interface AnalyticsRange {
  start: string;
  end: string;
  previousStart: string;
  previousEnd: string;
}

/** Percent change (null = no previous data) EXCEPT noShowRate: percentage POINTS. */
export interface AnalyticsKpiDeltas {
  total: number | null;
  completed: number | null;
  noShowRate: number | null;
  avgWaitMinutes: number | null;
  avgRating: number | null;
  uniqueCustomers: number | null;
}

export interface AnalyticsKpis {
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  completionRate: number;   // 0-100
  cancellationRate: number; // 0-100
  noShowRate: number;       // 0-100
  avgWaitMinutes: number | null;
  avgServiceMinutes: number | null;
  avgRating: number | null;
  ratingCount: number;
  walkInCount: number;
  onlineCount: number;
  uniqueCustomers: number;
  // ── Task 4 (super-admin analytics) ADDITIVE optional fields ──
  /** Channel rates 0-100, provided by the admin dashboard endpoint. */
  walkInRate?: number;
  onlineRate?: number;
  deltas: AnalyticsKpiDeltas;
}

export interface AnalyticsTimeseriesPoint {
  date: string; // 'YYYY-MM-DD' (daily periods) | 'YYYY-MM' (12m)
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  avgWaitMinutes: number | null;
  // ── Task 4 (super-admin analytics) ADDITIVE optional fields ──
  /** Channel split per point, provided by the admin dashboard endpoint. */
  walkIn?: number;
  online?: number;
}

export interface AnalyticsStatusDistributionItem {
  status: string; // WAITING | CALLED | SERVING | COMPLETED | CANCELLED | NO_SHOW
  count: number;
}

export interface AnalyticsHourlyTrafficPoint {
  hour: number; // 0..23
  count: number;
}

export interface AnalyticsWeekdayHourCell {
  weekday: number; // 0..6 (0 = Sunday)
  hour: number;    // 0..23
  count: number;
}

export interface AnalyticsServiceRow {
  serviceId: string;
  name: string;
  count: number;
  completed: number;
  cancelled: number;
  noShow: number;
  completionRate: number; // 0-100
  avgWaitMinutes: number | null;
}

export interface AnalyticsBranchRow {
  branchId: string;
  name: string;
  count: number;
  completed: number;
  noShowRate: number; // 0-100
  avgWaitMinutes: number | null;
}

export interface AnalyticsCounterRow {
  counterId: string;
  name: string;
  branchName: string;
  served: number;
  avgServiceMinutes: number | null;
}

export interface AnalyticsRatingDistributionItem {
  stars: number; // 1..5
  count: number;
}

export interface AnalyticsRatings {
  distribution: AnalyticsRatingDistributionItem[];
  average: number | null;
  count: number;
}

export interface AnalyticsPeak {
  busiestHour: number | null;
  busiestWeekday: number | null;
  busiestDay: string | null;
}

export interface AnalyticsDashboardData {
  period: AnalyticsPeriod;
  generatedAt: string;
  range: AnalyticsRange;
  kpis: AnalyticsKpis;
  timeseries: AnalyticsTimeseriesPoint[];
  statusDistribution: AnalyticsStatusDistributionItem[];
  hourlyTraffic: AnalyticsHourlyTrafficPoint[];
  weekdayHourMatrix: AnalyticsWeekdayHourCell[];
  services: AnalyticsServiceRow[];
  branches: AnalyticsBranchRow[];
  counters: AnalyticsCounterRow[];
  ratings: AnalyticsRatings;
  peak: AnalyticsPeak;
  /** Task 46 — online vs walk-in channel split. Optional: older local builds
   * (and cached payloads) predate this block; the UI hides the panel then. */
  channel?: {
    onlineCount: number;
    walkInCount: number;
    total: number;
    onlineRate: number;   // 0-100
    walkInRate: number;   // 0-100
    daily: Array<{ date: string; online: number; walkIn: number }>;
  };
}

/** Status colors for the new section — mirrors the app's status conventions
 * (WAITING amber · COMPLETED emerald · CANCELLED red · NO_SHOW rose) with the
 * blue/indigo slots remapped into the app's teal/cyan secondary accents. */
export const ANALYTICS_STATUS_META: Record<string, { color: string; labelKey: string }> = {
  WAITING: { color: '#f59e0b', labelKey: 'statusWaiting' },    // amber-500
  CALLED: { color: '#0891b2', labelKey: 'statusCalled' },      // cyan-600 (mirror of app's sky)
  SERVING: { color: '#14b8a6', labelKey: 'statusServing' },    // teal-500 (mirror of app's indigo slot)
  COMPLETED: { color: '#10b981', labelKey: 'statusCompleted' },// emerald-500
  CANCELLED: { color: '#ef4444', labelKey: 'statusCancelled' },// red-500
  NO_SHOW: { color: '#fb7185', labelKey: 'statusNoShow' },     // rose-400
};

export const STATUS_ORDER = ['WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const;
