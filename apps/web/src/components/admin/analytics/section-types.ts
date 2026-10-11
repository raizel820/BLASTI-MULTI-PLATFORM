'use client';

// ─── Task 54-b: super-admin analytics SECTION pages — API contract types ────
//
// Mirrors the frozen 54-a backend contract (agent-ctx/54-a-analytics-contract.md
// §1.2–1.14) for GET /api/admin/analytics/<section>. The Overview section keeps
// the pre-existing legacy dashboard types in ./types.ts — this file covers the
// 13 NEW section payloads only.
//
// All numeric fields arrive as numbers; `null` only where the contract allows
// it (averages with no data). Buckets are UTC and ZERO-FILLED — render
// directly: 'YYYY-MM-DDTHH' (hourly) | 'YYYY-MM-DD' (daily) | 'YYYY-MM'
// (monthly). Every 200 payload carries `resolved` (§0.1).

// ─── §3.1 period subset exposed by the section toolbar (Task 54-b spec C:
// today / 7d / 30d / this-month / this-year / custom) ─────────────────────────
export type AdminSectionPeriod =
  | 'today'
  | '7d'
  | '30d'
  | 'this-month'
  | 'this-year'
  | 'custom';

export const ADMIN_SECTION_PERIODS: AdminSectionPeriod[] = [
  'today',
  '7d',
  '30d',
  'this-month',
  'this-year',
  'custom',
];

/** §5.1 sub-navigation ids. 'overview' renders the pre-existing dashboard. */
export type AdminSectionId =
  | 'overview'
  | 'users'
  | 'agencies'
  | 'categories'
  | 'reservations'
  | 'queues'
  | 'services'
  | 'customers'
  | 'subscriptions'
  | 'payments'
  | 'sms'
  | 'notifications'
  | 'devices'
  | 'security-audit'
  | 'data-consumption';

/** §0.1 `resolved` window (present on every new section payload). */
export interface AdminResolvedWindow {
  period: string;
  granularity: 'hourly' | 'daily' | 'monthly';
  from: string;
  to: string;
  previousFrom?: string;
  previousTo?: string;
}

/** Compact map<string, number> blocks (byRole, byTier, byStatus, byType…). */
export type AdminCountMap = Record<string, number>;

// ─── §1.2 users ──────────────────────────────────────────────────────────────
export interface AdminUsersData {
  resolved: AdminResolvedWindow;
  totals: {
    totalUsers: number;
    activeUsers: number;
    suspendedUsers: number;
    verifiedUsers: number;
    unverifiedUsers: number;
    newUsersInPeriod: number;
  };
  byRole: AdminCountMap;
  newByRole: AdminCountMap;
  activity: { dau: number; wau: number; mau: number };
  newUsersTimeseries: Array<{ bucket: string; count: number }>;
}

// ─── §1.3 agencies ───────────────────────────────────────────────────────────
export interface AdminAgenciesData {
  resolved: AdminResolvedWindow;
  totals: {
    total: number;
    active: number;
    inactive: number;
    pendingApprovals: number;
    newInPeriod: number;
  };
  byCategory: AdminCountMap;
  bySubscriptionTier: AdminCountMap;
  bySubscriptionStatus: AdminCountMap;
  newAgenciesTimeseries: Array<{ bucket: string; count: number }>;
  platform: { totalBranches: number; totalServices: number; totalCounters: number };
}

// ─── §1.4 categories ─────────────────────────────────────────────────────────
export interface AdminCategoryRow {
  category: string;
  agencies: number;
  activeAgencies: number;
  newAgencies: number;
  branches: number;
  services: number;
  counters: number;
  staff: number;
  activeStaff: number;
  reservations: number;
  completed: number;
  cancelled: number;
  noShow: number;
  completionRate: number;   // 0-100
  cancellationRate: number; // 0-100
  noShowRate: number;       // 0-100
  avgWaitMinutes: number | null;
}

export interface AdminCategoriesData {
  resolved: AdminResolvedWindow;
  categories: AdminCategoryRow[];
}

// ─── §1.5 reservations (§3.2 filter set on the query string) ─────────────────
export interface AdminResKpis {
  total: number;
  byStatus: AdminCountMap;
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

export interface AdminResTimeseriesPoint {
  bucket: string;
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  walkIn: number;
  online: number;
  avgWaitMinutes: number | null;
}

export interface AdminTopServiceRow {
  serviceId: string;
  name: string;
  agencyId: string;
  key?: string | null;
  count: number;
  completed: number;
  cancelled: number;
  noShow: number;
  walkIn: number;
  online: number;
  completionRate: number;
  avgWaitMinutes: number | null;
  avgServiceMinutes: number | null;
}

export interface AdminTopBranchRow {
  branchId: string;
  name: string;
  count: number;
  completed: number;
  cancelled: number;
  noShow: number;
  completionRate: number;
  avgWaitMinutes: number | null;
  avgServiceMinutes: number | null;
}

export interface AdminTopAgencyStatRow {
  agencyId: string;
  name: string;
  customCode: string | null;
  category: string | null;
  count: number;
  completed: number;
  cancelled: number;
  noShow: number;
  completionRate: number;
  avgWaitMinutes: number | null;
  avgServiceMinutes: number | null;
}

export interface AdminReservationsData {
  resolved: AdminResolvedWindow;
  kpis: AdminResKpis;
  statusDistribution: Array<{ status: string; count: number }>;
  channel: {
    onlineCount: number;
    walkInCount: number;
    total: number;
    onlineRate: number;
    walkInRate: number;
    daily: Array<{ bucket: string; online: number; walkIn: number }>;
  };
  timeseries: AdminResTimeseriesPoint[];
  hourlyTraffic: Array<{ hour: number; count: number }>;
  weekdayTraffic: Array<{ weekday: number; count: number }>;
  peak: { busiestHour: number | null; busiestWeekday: number | null; busiestDay: string | null };
  topBranches: AdminTopBranchRow[];
  topServices: AdminTopServiceRow[];
  topAgencies: AdminTopAgencyStatRow[];
}

// ─── §1.6 queues ─────────────────────────────────────────────────────────────
export interface AdminQueuesData {
  resolved: AdminResolvedWindow;
  live: {
    agenciesWithOpenQueue: number;
    agenciesPaused: number;
    currentlyWaiting: number;
    currentlyCalled: number;
    currentlyServing: number;
  };
  today: { ticketsServedToday: number };
  period: {
    ticketsInPeriod: number;
    ticketsServedInPeriod: number;
    callsInPeriod: number;
    avgWaitingTimeMinutes: number | null;
    medianWaitingTimeMinutes: number | null;
    avgServiceDurationMinutes: number | null;
    callsPerHour: number;
    customersServedPerHour: number;
    noShowRate: number;
    abandonmentRate: number;
    hourlyCalls: Array<{ hour: number; count: number }>;
  };
}

// ─── §1.7 services ───────────────────────────────────────────────────────────
export interface AdminServicesData {
  resolved: AdminResolvedWindow;
  totals: { totalServices: number; activeServices: number; servicesPerAgencyAvg: number };
  topServices: AdminTopServiceRow[];
}

// ─── §1.8 customers ──────────────────────────────────────────────────────────
export interface AdminCustomersData {
  resolved: AdminResolvedWindow;
  totals: {
    totalCustomers: number;
    newCustomersInPeriod: number;
    customersWithReservationInPeriod: number;
    reservationsPerCustomer: number;
  };
  topCustomers: Array<{ userId: string; name: string; reservations: number }>;
}

// ─── §1.9 subscriptions ──────────────────────────────────────────────────────
export interface AdminSubscriptionsData {
  resolved: AdminResolvedWindow;
  totals: {
    activeSubscriptions: number;
    newSubscriptionsInPeriod: number;
    expiringWithin30Days: number;
    agenciesWithoutPlan: number;
    plansInCatalog: number;
  };
  planDistribution: Array<{ planId: string; planName: string; agencies: number }>;
  byTier: AdminCountMap;
  byStatus: AdminCountMap;
}

// ─── §1.10 payments ──────────────────────────────────────────────────────────
export interface AdminPaymentsData {
  resolved: AdminResolvedWindow;
  totals: {
    transactionsInPeriod: number;
    successfulPayments: number;
    pendingPayments: number;
    rejectedPayments: number;
    totalRevenue: number;
    currency: string;
    avgTransactionValue: number;
  };
  byStatus: Record<string, { count: number; value: number }>;
  byPaymentMethod: Record<string, { count: number; value: number }>;
  revenueTimeseries: Array<{ bucket: string; revenue: number }>;
}

// ─── §1.11 sms ───────────────────────────────────────────────────────────────
export interface AdminSmsData {
  resolved: AdminResolvedWindow;
  messages: {
    sentInPeriod: number;
    delivered: number;
    failed: number;
    byStatus: AdminCountMap;
  };
  purchases: {
    count: number;
    units: number;
    value: number;
    byStatus: AdminCountMap;
  };
  provider: { enabled: boolean; provider: string | null };
}

// ─── §1.12 notifications ─────────────────────────────────────────────────────
export interface AdminNotificationsData {
  resolved: AdminResolvedWindow;
  totals: { countInPeriod: number; unreadInPeriod: number; totalAllTime: number };
  byType: AdminCountMap;
}

// ─── §1.13 devices ───────────────────────────────────────────────────────────
export interface AdminDevicesData {
  resolved: AdminResolvedWindow;
  agencyDevices: {
    total: number;
    activeInPeriod: number;
    online: number;
    offline: number;
    onlineByHeartbeat15m: number;
    byStatus: AdminCountMap;
    byType: AdminCountMap;
    byConnection: AdminCountMap;
    totalUptimeSec: number;
  };
  customerDevices: {
    total: number;
    newInPeriod: number;
    activeLast7d: number;
    byPlatform: AdminCountMap;
  };
}

// ─── §1.14 security-audit ────────────────────────────────────────────────────
export interface AdminSecurityAuditData {
  resolved: AdminResolvedWindow;
  totals: { eventsInPeriod: number; distinctActors: number };
  topActions: Array<{ action: string; count: number }>;
  byEntityType: AdminCountMap;
}

// ─── Task 55-c: data-consumption (agent-ctx/55-data-consumption-contract.md §2.4) ──
// ALL byte counters are RAW INTEGER BYTES — the frontend does the binary-1024
// unit math (B | KB | MB | GB | TB). `network` on the query is ALL | WIFI |
// MOBILE (ALL includes UNKNOWN buckets); `trafficType` is ALL + the 6 types.
export interface AdminDataUsageAgencyRow {
  agencyId: string;
  agencyName: string;
  agencyCode: string;
  wilaya: string;
  category: string;
  isActive: boolean;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
  events: number;
  branchCount: number;
  /** 0-100, 1 decimal — row total / totals.totalBytes * 100. */
  sharePercent: number;
}

export interface AdminDataUsageCustomerRow {
  userId: string;
  customerName: string;
  username: string;
  totalBytes: number;
  events: number;
  lastActivityAt: string;
}

export interface AdminDataConsumptionData {
  resolved: AdminResolvedWindow;
  totals: {
    uploadBytes: number;
    downloadBytes: number;
    totalBytes: number;
    events: number;
  };
  byNetwork: { WIFI: number; MOBILE: number; UNKNOWN: number };
  byTrafficType: {
    API: number;
    SYNC: number;
    REALTIME: number;
    NOTIFICATIONS: number;
    FILES: number;
    UPDATES: number;
  };
  averages: {
    perAgency: number;
    perBranch: number;
    perCustomer: number;
    perDevice: number;
    agencyCount: number;
    branchCount: number;
    customerCount: number;
    deviceCount: number;
  };
  /** ONE row per agency WITH events in the window — sorted totalBytes desc.
   *  Platform-level events (agencyId null) are in totals but have NO row. */
  byAgency: AdminDataUsageAgencyRow[];
  topCustomers: AdminDataUsageCustomerRow[];
  timeseries: Array<{
    date: string; // 'YYYY-MM-DD' local-day bucket
    uploadBytes: number;
    downloadBytes: number;
    totalBytes: number;
  }>;
  peaks: { hour: number; hourBytes: number; day: string; dayBytes: number };
  meta: {
    /** MIN(createdAt) over ALL events (unfiltered) — when recording started. */
    recordedSince: string | null;
    excludedUnknownNetworkBytes: number;
  };
}

/** §3.2 data-consumption filters — empty string = not sent (ALL). */
export interface AdminDataConsumptionFilters {
  category: string;
  wilaya: string;
  agencyId: string;
  /** '' = ALL (includes UNKNOWN) | WIFI | MOBILE. */
  network: string;
  /** '' = ALL | API | SYNC | REALTIME | NOTIFICATIONS | FILES | UPDATES. */
  trafficType: string;
}

export const EMPTY_DATA_CONSUMPTION_FILTERS: AdminDataConsumptionFilters = {
  category: '',
  wilaya: '',
  agencyId: '',
  network: '',
  trafficType: '',
};

/** Union of every section payload the parameterized hook can return. */
export type AdminSectionPayload =
  | AdminUsersData
  | AdminAgenciesData
  | AdminCategoriesData
  | AdminReservationsData
  | AdminQueuesData
  | AdminServicesData
  | AdminCustomersData
  | AdminSubscriptionsData
  | AdminPaymentsData
  | AdminSmsData
  | AdminNotificationsData
  | AdminDevicesData
  | AdminSecurityAuditData
  | AdminDataConsumptionData;

/** §3.2 org filters — admin/analytics/reservations only. */
export interface AdminReservationFilters {
  agencyId: string;
  category: string;
  wilaya: string;
  branchId: string;
  counterId: string;
  serviceId: string;
  staffId: string;
  status: string;
  channel: string; // '' | walkIn | online
}

export const EMPTY_RESERVATION_FILTERS: AdminReservationFilters = {
  agencyId: '',
  category: '',
  wilaya: '',
  branchId: '',
  counterId: '',
  serviceId: '',
  staffId: '',
  status: '',
  channel: '',
};
