'use client';

// ─── Task 4: Super-Admin Analytics & Statistics — API contract types ────────
//
// Extends the agency analytics contract (src/components/agency/analytics/
// types.ts) with the admin-only surfaces of:
//   GET /api/admin/analytics/dashboard?period=7d|30d|90d|12m&scope=global|average
//   GET /api/admin/analytics/agency/:agencyId?period=…
//
// scope='average' → count values are per-active-agency averages (fractional,
// 1 decimal); scope='global' → raw platform totals.

import type { AnalyticsDashboardData } from '@/components/agency/analytics/types';

export type AdminAnalyticsScope = 'global' | 'average';

export interface AdminChannelDailyPoint {
  date: string; // 'YYYY-MM-DD' (daily periods) | 'YYYY-MM' (12m)
  online: number;
  walkIn: number;
}

export interface AdminChannelStats {
  onlineCount: number;
  walkInCount: number;
  total: number;
  onlineRate: number;   // 0-100
  walkInRate: number;   // 0-100
  daily: AdminChannelDailyPoint[];
}

export interface AdminPlatformStats {
  totalAgencies: number;
  activeAgencies: number;
  totalCustomers: number;
  newCustomersInPeriod: number;
  totalReservationsAllTime: number;
  onlineRateAllTime: number;   // 0-100
  walkInRateAllTime: number;   // 0-100
}

export interface AdminTopAgencyRow {
  agencyId: string;
  name: string;
  customCode: string;
  category: string;
  total: number;
  completed: number;
  completionRate: number; // 0-100
  onlineCount: number;
  walkInCount: number;
  onlineRate: number;     // 0-100
  walkInRate: number;     // 0-100
  avgWaitMinutes: number | null;
  avgRating: number | null;
}

export interface AdminAgencyInfo {
  id: string;
  name: string;
  customCode: string;
  category: string;
  wilaya: string | null;
  city: string | null;
  isActive: boolean;
  subscriptionTier: string | null;
}

/** GET /api/admin/analytics/dashboard (global | average scope) payload. */
export interface AdminAnalyticsDashboardData extends AnalyticsDashboardData {
  scope: AdminAnalyticsScope;
  channel: AdminChannelStats;
  topAgencies: AdminTopAgencyRow[];
  platform: AdminPlatformStats;
}

/** GET /api/admin/analytics/agency/:agencyId payload. */
export interface AdminAgencyAnalyticsData extends AnalyticsDashboardData {
  channel: AdminChannelStats;
  agency: AdminAgencyInfo;
}

export type AdminAnalyticsPayload = AdminAnalyticsDashboardData | AdminAgencyAnalyticsData;

/** The per-agency payload is the one WITHOUT the platform block. */
export function isAgencyScopedPayload(d: AdminAnalyticsPayload): d is AdminAgencyAnalyticsData {
  return !('platform' in d) || d.platform === null || d.platform === undefined;
}

/** Row returned by GET /api/admin/agencies?search=…&limit=8 */
export interface AdminAgencySearchResult {
  id: string;
  name: string;
  customCode: string;
  category: string;
  city: string | null;
  isActive: boolean;
}

/** Minimal agency descriptor kept in the dashboard state after selection. */
export interface AdminSelectedAgency {
  id: string;
  name: string;
  customCode?: string;
  category?: string;
  city?: string | null;
  isActive?: boolean;
}
