'use client';

// ─── Task 54-c: Agency OWNER analytics SECTION pages — API contract types ───
//
// Mirrors the frozen 54-a backend contract (agent-ctx/54-a-analytics-contract.md
// §2.1–2.10) for GET /api/agency/analytics/<section>. The Overview tab keeps the
// pre-existing legacy dashboard types in ./types.ts — this file covers the 9 NEW
// section payloads only (§18-§27).
//
// All numeric fields arrive as numbers; `null` only where the contract allows
// it (averages with no data). Buckets are UTC and ZERO-FILLED — render
// directly: 'YYYY-MM-DD' (daily) | 'YYYY-MM' (monthly). Every 200 payload
// carries `resolved` (§0.1). Every query is locked to the caller's own agency
// server-side (§4/§50) — no agencyId filter is exposed here (admin-only).

// ─── §3.1 period subset exposed by the section toolbar (Task 54-c spec C:
// today / 7d / 30d / this-month / this-year / custom — owner default 30d) ─────
export type OwnerSectionPeriod =
  | 'today'
  | '7d'
  | '30d'
  | 'this-month'
  | 'this-year'
  | 'custom';

export const OWNER_SECTION_PERIODS: OwnerSectionPeriod[] = [
  'today',
  '7d',
  '30d',
  'this-month',
  'this-year',
  'custom',
];

/** §16 sub-navigation ids. 'overview' renders the pre-existing dashboard. */
export type OwnerSectionId =
  | 'overview'
  | 'reservations'
  | 'queue'
  | 'branches'
  | 'staff'
  | 'customers'
  | 'satisfaction'
  | 'working-hours'
  | 'payments'
  | 'devices';

/** §0.1 `resolved` window (present on every new section payload). */
export interface OwnerResolvedWindow {
  period: string;
  granularity: 'hourly' | 'daily' | 'monthly';
  from: string;
  to: string;
  previousFrom?: string;
  previousTo?: string;
}

/** Compact map<string, number> blocks (byStatus, byType, byConnection…). */
export type OwnerCountMap = Record<string, number>;

/** Shared per-group reservation stats row (backend groupReservationStats). */
export interface OwnerGroupStats {
  count: number;
  completed: number;
  cancelled: number;
  noShow: number;
  walkIn: number;
  online: number;
  completionRate: number;      // 0-100
  avgWaitMinutes: number | null;
  avgServiceMinutes: number | null;
}

// ─── §2.2 reservations (§18 — §3.2 filters minus agencyId) ───────────────────
export interface OwnerResKpis {
  total: number;
  byStatus: OwnerCountMap;
  completed: number;
  cancelled: number;
  noShow: number;
  waiting: number;
  called: number;
  serving: number;
  completionRate: number;
  cancellationRate: number;
  noShowRate: number;
  walkInCount: number;
  onlineCount: number;
  walkInRate: number;
  onlineRate: number;
  uniqueCustomers: number;
  avgWaitMinutes: number | null;
  medianWaitMinutes: number | null;
  maxWaitMinutes: number | null;
  avgServiceMinutes: number | null;
  medianServiceMinutes: number | null;
  maxServiceMinutes: number | null;
  customersPerHour: number;
}

export interface OwnerResTimeseriesPoint {
  bucket: string;
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  walkIn: number;
  online: number;
  avgWaitMinutes: number | null;
}

export interface OwnerReservationsData {
  resolved: OwnerResolvedWindow;
  kpis: OwnerResKpis;
  statusDistribution: Array<{ status: string; count: number }>;
  channel: {
    onlineCount: number;
    walkInCount: number;
    total: number;
    onlineRate: number;
    walkInRate: number;
    daily: Array<{ bucket: string; online: number; walkIn: number }>;
  };
  timeseries: OwnerResTimeseriesPoint[];
  hourlyTraffic: Array<{ hour: number; count: number }>;
  weekdayTraffic: Array<{ weekday: number; count: number }>;
  peak: { busiestHour: number | null; busiestWeekday: number | null; busiestDay: string | null };
  byService: Array<OwnerGroupStats & { serviceId: string; name: string }>;
  byBranch: Array<OwnerGroupStats & { branchId: string; name: string }>;
  byCounter: Array<OwnerGroupStats & { counterId: string; name: string; branchName: string }>;
}

/** §3.2 org filters exposed by the owner reservations section (NO agencyId —
 *  the backend locks every owner query to the caller's own agency). */
export interface OwnerReservationFilters {
  branchId: string;
  counterId: string;
  serviceId: string;
  staffId: string;
  status: string;
  channel: string; // '' | walkIn | online
}

export const EMPTY_OWNER_RESERVATION_FILTERS: OwnerReservationFilters = {
  branchId: '',
  counterId: '',
  serviceId: '',
  staffId: '',
  status: '',
  channel: '',
};

// ─── §2.3 queue (§19 live + period) ──────────────────────────────────────────
export interface OwnerQueueData {
  resolved: OwnerResolvedWindow;
  queueStatus: {
    isQueueOpen: boolean;
    isPaused: boolean;
    pausedAt: string | null;
    openedAt: string | null;
  };
  live: {
    currentlyWaiting: number;
    currentlyCalled: number;
    currentlyServing: number;
    queueLength: number;
    nextTicket: { id: string; displayNumber: string; joinedAt: string } | null;
    avgCurrentWaitMinutes: number | null;
  };
  period: {
    avgWaitingTimeMinutes: number | null;
    medianWaitingTimeMinutes: number | null;
    maxWaitingTimeMinutes: number | null;
    avgServiceDurationMinutes: number | null;
    callsPerHour: number;
    customersServedPerHour: number;
    noShowRate: number;
    abandonmentRate: number;
    queueSizeByHour: Array<{ hour: number; count: number }>;
    counterUtilization: Array<{
      counterId: string;
      name: string;
      isActive: boolean;
      served: number;
      utilizationPct: number;
      avgServiceMinutes: number | null;
    }>;
  };
}

// ─── §2.4 branches (§20) ─────────────────────────────────────────────────────
export interface OwnerBranchRow {
  branchId: string;
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  isActive: boolean;
  isMain: boolean;
  countersTotal: number;
  countersActive: number;
  staffActive: number;
  devicesTotal: number;
  devicesOnline: number;
  reservations: number;
  customersServed: number;
  completed: number;
  cancelled: number;
  noShow: number;
  completionRate: number;
  avgWaitMinutes: number | null;
  avgServiceMinutes: number | null;
}

export interface OwnerBranchesData {
  resolved: OwnerResolvedWindow;
  totals: { branches: number; reservationsInPeriod: number };
  branches: OwnerBranchRow[];
}

// ─── §2.5 staff (§21) ────────────────────────────────────────────────────────
export interface OwnerStaffRow {
  staffId: string;
  userId: string;
  name: string;
  role: string; // STAFF | MANAGER
  isActive: boolean;
  branchId: string | null;
  countersAssigned: number;
  reservationsHandled: number;
  completed: number;
  cancelled: number;
  noShow: number;
  completionRate: number;
  avgServiceMinutes: number | null;
  avgWaitMinutes: number | null;
}

export interface OwnerStaffData {
  resolved: OwnerResolvedWindow;
  totals: { staff: number; active: number };
  staff: OwnerStaffRow[];
}

// ─── §2.6 customers (§22 own-agency customers) ───────────────────────────────
export interface OwnerCustomersData {
  resolved: OwnerResolvedWindow;
  totals: {
    uniqueCustomers: number;
    newCustomers: number;
    returningCustomers: number;
    repeatVisits: number;
    reservationsPerCustomer: number;
    cancellationRate: number;
    noShowRate: number;
  };
  mostRequestedServices: Array<{ serviceId: string; name: string; count: number }>;
  topCustomers: Array<{ userId: string; name: string; reservations: number }>;
}

// ─── §2.7 satisfaction (§23 review aggregates) ───────────────────────────────
export interface OwnerSatisfactionData {
  resolved: OwnerResolvedWindow;
  summary: {
    average: number | null;
    count: number;
    distribution: Array<{ stars: number; count: number }>;
    responseRate: number;
    responded: number;
  };
  byService: Array<{ serviceId: string; name: string; count: number; avgRating: number | null }>;
  byBranch: Array<{ branchId: string; name: string; count: number; avgRating: number | null }>;
  ratingTrend: Array<{ bucket: string; avgRating: number | null; count: number }>;
}

// ─── §2.8 working-hours (§24; owner/admin only — staff 403) ──────────────────
export interface OwnerWorkingHoursData {
  resolved: OwnerResolvedWindow;
  operatingHours: { start: string | null; end: string | null; workingDays: string | null };
  reservationsByHour: Array<{ hour: number; count: number }>;
  servedByHour: Array<{ hour: number; count: number }>;
  avgWaitByHour: Array<{ hour: number; avgWaitMinutes: number | null }>;
  weekdayTraffic: Array<{ weekday: number; count: number }>;
  peak: { busiestHour: number | null; busiestWeekday: number | null; busiestDay: string | null };
}

// ─── §2.9 payments (§26 own agency; owner/admin only — staff 403) ────────────
export interface OwnerPaymentsData {
  resolved: OwnerResolvedWindow;
  subscription: {
    tier: string;
    status: string;
    startsAt: string | null;
    expiresAt: string | null;
    plan: { name: string; displayName: string; price: number; billingCycle: string } | null;
  } | null;
  totals: {
    transactionsInPeriod: number;
    paid: number;
    pending: number;
    rejected: number;
    totalPaid: number;
    currency: string;
  };
  byStatus: Record<string, { count: number; value: number }>;
  byPaymentMethod: OwnerCountMap;
  paymentTimeseries: Array<{ bucket: string; value: number }>;
}

// ─── §2.10 devices (§27) ─────────────────────────────────────────────────────
export interface OwnerDeviceRow {
  id: string;
  name: string;
  type: string;
  status: string;
  branchId: string | null;
  lastHeartbeatAt: string | null;
  offlineCapable: boolean;
}

export interface OwnerDevicesData {
  resolved: OwnerResolvedWindow;
  totals: { devices: number; online: number; offline: number; totalUptimeSec: number };
  byStatus: OwnerCountMap;
  byType: OwnerCountMap;
  byConnection: OwnerCountMap;
  devices: OwnerDeviceRow[];
  hardwareOrdersInPeriod: { count: number; byStatus: OwnerCountMap };
}

/** Union of every section payload the parameterized hook can return. */
export type OwnerSectionPayload =
  | OwnerReservationsData
  | OwnerQueueData
  | OwnerBranchesData
  | OwnerStaffData
  | OwnerCustomersData
  | OwnerSatisfactionData
  | OwnerWorkingHoursData
  | OwnerPaymentsData
  | OwnerDevicesData;
