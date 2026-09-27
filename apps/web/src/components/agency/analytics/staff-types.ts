'use client';

// ─── Task 54-d: Agency STAFF analytics SECTION pages — API contract types ────
//
// Mirrors the frozen 54-a backend contract (agent-ctx/54-a-analytics-contract.md
// §3.1–3.4) for GET /api/staff/analytics/<section>. Data scope is enforced
// SERVER-SIDE (staff row's agency + assigned branch + assigned counters) —
// no scope parameter is ever sent from the client.
//
// §31 my-overview + §32 today-queue are FIXED-TODAY operational views: their
// payloads carry NO `resolved` window and put the data under `today:` — the
// shell renders them without a period selector. §33 my-performance + §34
// my-services accept the §3.1 period system (default 30d) and carry `resolved`.
//
// All numeric fields arrive as numbers; `null` only where the contract allows
// it (averages with no data). Buckets are UTC and ZERO-FILLED — render
// directly: 'YYYY-MM-DD' (daily) | 'YYYY-MM' (monthly) | 'YYYY-MM-DDTHH'
// (hourly, today periods).

// ─── §3.1 period subset exposed by the staff toolbar (doc-2 §33/§34;
// my-performance + my-services only — default 30d, mirroring the owner shell) ──
export type StaffSectionPeriod =
  | 'today'
  | '7d'
  | '30d'
  | 'this-month'
  | 'this-year'
  | 'custom';

export const STAFF_SECTION_PERIODS: StaffSectionPeriod[] = [
  'today',
  '7d',
  '30d',
  'this-month',
  'this-year',
  'custom',
];

/** §30 sub-navigation ids. */
export type StaffSectionId = 'my-overview' | 'today-queue' | 'my-performance' | 'my-services';

/** §0.1 `resolved` window (present on my-performance + my-services). */
export interface StaffResolvedWindow {
  period: string;
  granularity: 'hourly' | 'daily' | 'monthly';
  from: string;
  to: string;
  previousFrom?: string;
  previousTo?: string;
}

/** Compact map<string, number> blocks. */
export type StaffCountMap = Record<string, number>;

// ─── §3.1 my-overview (§31 — TODAY, ignores period) ──────────────────────────
export interface StaffMyOverviewData {
  /** §0.1 EXCEPTION: fixed-TODAY payloads carry no `resolved` — optional here
   *  purely so the shared hook can read it defensively (`?? null`). */
  resolved?: StaffResolvedWindow;
  scope: { branchId: string | null; role: string; note?: string };
  today: {
    ticketsServed: number;
    reservationsHandled: number;
    completed: number;
    cancelled: number;
    noShow: number;
    completionRate: number;      // 0-100
    avgWaitingTimeMinutes: number | null;
    avgServiceDurationMinutes: number | null;
    currentlyServing: number;
    waitingCount: number;
    calledCount: number;
    statusDistribution: Array<{ status: string; count: number }>;
  };
  hourlyTraffic: Array<{ hour: number; count: number }>;
}

// ─── §3.2 today-queue (§32, ignores period) ──────────────────────────────────
export interface StaffTodayQueueData {
  /** Same defensive optionality as my-overview (no `resolved` on this view). */
  resolved?: StaffResolvedWindow;
  scope: { branchId: string | null; note?: string };
  queueStatus: {
    isQueueOpen: boolean;
    isPaused: boolean;
    pausedAt: string | null;
    currentServingNumber: number;
    lastIssuedNumber: number;
  };
  live: {
    queueLength: number;
    currentlyWaiting: number;
    currentlyCalled: number;
    servingCustomer: { id: string; displayNumber: string; joinedAt: string } | null;
    nextTicket: { id: string; displayNumber: string; joinedAt: string } | null;
    calledTickets: Array<{ id: string; displayNumber: string; joinedAt: string }>;
    avgCurrentWaitMinutes: number | null;
  };
  today: { ticketsCompleted: number; noShows: number };
}

// ─── §3.3 my-performance (§33, accepts period) ───────────────────────────────
export interface StaffPerformanceData {
  resolved: StaffResolvedWindow;
  scope: { branchId: string | null; role: string };
  kpis: {
    ticketsCalled: number;
    ticketsServed: number;
    completed: number;
    cancelled: number;
    noShow: number;
    completionRate: number;      // 0-100
    avgHandlingTimeMinutes: number | null;
    avgServiceDurationMinutes: number | null;
    medianServiceDurationMinutes: number | null;
    avgWaitingTimeMinutes: number | null;
    customersPerHour: number | null;
  };
  statusDistribution: Array<{ status: string; count: number }>;
  timeseries: Array<{
    bucket: string;
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    walkIn: number;
    online: number;
    avgWaitMinutes: number | null;
  }>;
  byCounter: Array<{
    counterId: string;
    name: string;
    served: number;
    avgServiceMinutes: number | null;
  }>;
  /** groupReservationStats rows + serviceId/name (backend spreads the group). */
  byService: Array<{
    serviceId: string;
    name: string;
    key: string;
    count: number;
    completed: number;
    cancelled: number;
    noShow: number;
    walkIn: number;
    online: number;
    completionRate: number;
    avgWaitMinutes: number | null;
    avgServiceMinutes: number | null;
  }>;
  peak: { busiestHour: number | null; busiestWeekday: number | null; busiestDay: string | null };
}

// ─── §3.4 my-services (§34, accepts period) ──────────────────────────────────
export interface StaffServicesData {
  resolved: StaffResolvedWindow;
  scope: { branchId: string | null };
  totals: { services: number; reservationsInScope: number };
  services: Array<{
    serviceId: string;
    name: string;
    prefix: string | null;
    reservations: number;
    completed: number;
    cancelled: number;
    noShow: number;
    avgWaitMinutes: number | null;
    avgServiceMinutes: number | null;
    demand: number;
  }>;
  peakHours: Array<{ hour: number; count: number }>;
}

/** Union of every staff section payload the parameterized hook can return. */
export type StaffSectionPayload =
  | StaffMyOverviewData
  | StaffTodayQueueData
  | StaffPerformanceData
  | StaffServicesData;
