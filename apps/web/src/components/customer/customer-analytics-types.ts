'use client';

// ─── Task 54-d: CUSTOMER analytics module — API contract types ───────────────
//
// Mirrors the frozen 54-a backend contract (agent-ctx/54-a-analytics-contract.md
// §4.1–4.5) for GET /api/customer/analytics/<section>. Scope is completely
// personal (§38) — every query filters userId = caller SERVER-SIDE before
// aggregation; no userId parameter is ever sent from the client.
//
// Defaults (backend-enforced): my-overview + my-activity 30d, my-reservations
// + my-queue-history + my-ratings 12m. Every 200 payload carries `resolved`
// (§0.1). Buckets are UTC and ZERO-FILLED — render directly: 'YYYY-MM-DD'
// (daily) | 'YYYY-MM' (monthly).

// ─── §3.1 period subset exposed by the customer toolbar (all 5 sections
// accept the period; defaults per section come from the backend) ─────────────
export type CustomerSectionPeriod =
  | 'today'
  | '7d'
  | '30d'
  | 'this-month'
  | '12m'
  | 'this-year'
  | 'custom';

export const CUSTOMER_SECTION_PERIODS: CustomerSectionPeriod[] = [
  'today',
  '7d',
  '30d',
  'this-month',
  '12m',
  'this-year',
  'custom',
];

/** §39 sub-navigation ids. */
export type CustomerSectionId =
  | 'my-overview'
  | 'my-reservations'
  | 'my-queue-history'
  | 'my-activity'
  | 'my-ratings';

/** Backend default period per section (contract §4). */
export const CUSTOMER_SECTION_DEFAULT_PERIOD: Record<CustomerSectionId, CustomerSectionPeriod> = {
  'my-overview': '30d',
  'my-reservations': '12m',
  'my-queue-history': '12m',
  'my-activity': '30d',
  'my-ratings': '12m',
};

/** §0.1 `resolved` window (present on every customer section payload). */
export interface CustomerResolvedWindow {
  period: string;
  granularity: 'hourly' | 'daily' | 'monthly';
  from: string;
  to: string;
  previousFrom?: string;
  previousTo?: string;
}

/** Timeseries point (shared aggregateReservations shape). */
export interface CustomerTimeseriesPoint {
  bucket: string;
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  walkIn: number;
  online: number;
  avgWaitMinutes: number | null;
}

/** groupReservationStats row (backend spread). */
export interface CustomerGroupStats {
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
}

// ─── §4.1 my-overview (§40; default 30d) ─────────────────────────────────────
export interface CustomerMyOverviewData {
  resolved: CustomerResolvedWindow;
  totals: {
    totalReservations: number;
    completed: number;
    cancelled: number;
    noShow: number;
    upcoming: number;
    favoriteAgencies: number;
    agenciesUsed: number;
    servicesUsed: number;
  };
  period: {
    reservations: number;
    avgWaitingTimeMinutes: number | null;
    avgServiceDurationMinutes: number | null;
    timeseries: CustomerTimeseriesPoint[];
  };
}

// ─── §4.2 my-reservations (§41; default 12m) ─────────────────────────────────
export interface CustomerMyReservationsData {
  resolved: CustomerResolvedWindow;
  statusDistribution: Array<{ status: string; count: number }>;
  timeseries: CustomerTimeseriesPoint[];
  byType: { online: number; walkIn: number; fixedTime: number };
  completedCancelledNoShow: { completed: number; cancelled: number; noShow: number };
  avgWaitingTimeMinutes: number | null;
  avgServiceTimeMinutes: number | null;
  mostUsedAgencies: Array<CustomerGroupStats & { agencyId: string; name: string; category: string | null }>;
  mostUsedServices: Array<CustomerGroupStats & { serviceId: string; name: string }>;
}

// ─── §4.3 my-queue-history (§42; default 12m) ────────────────────────────────
export interface CustomerMyQueueHistoryData {
  resolved: CustomerResolvedWindow;
  totals: {
    timesJoinedQueue: number;
    completedVisits: number;
    noShows: number;
    cancelledVisits: number;
  };
  wait: {
    averageMinutes: number | null;
    longestMinutes: number | null;
    shortestMinutes: number | null;
  };
  service: {
    averageMinutes: number | null;
  };
}

// ─── §4.4 my-activity (§43; default 30d) ─────────────────────────────────────
export interface CustomerMyActivityData {
  resolved: CustomerResolvedWindow;
  favorites: {
    count: number;
    agencies: Array<{ agencyId: string; name: string; category: string }>;
    newInPeriod: number;
  };
  notifications: {
    receivedInPeriod: number;
    unread: number;
    total: number;
  };
  reviews: { count: number };
  reservations: { inPeriod: number };
}

// ─── §4.5 my-ratings (§44; default 12m) ──────────────────────────────────────
export interface CustomerMyRatingsData {
  resolved: CustomerResolvedWindow;
  summary: {
    reviewsSubmitted: number;
    averageRatingGiven: number | null;
    distribution: Array<{ stars: number; count: number }>;
    agenciesReviewed: number;
    servicesReviewed: number;
  };
  history: Array<{
    id: string;
    rating: number;
    comment: string | null;
    createdAt: string;
    agencyId: string;
    agencyName: string;
    serviceId: string | null;
  }>;
}

/** Union of every customer section payload the parameterized hook can return. */
export type CustomerSectionPayload =
  | CustomerMyOverviewData
  | CustomerMyReservationsData
  | CustomerMyQueueHistoryData
  | CustomerMyActivityData
  | CustomerMyRatingsData;
