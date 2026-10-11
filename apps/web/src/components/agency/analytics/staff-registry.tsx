'use client';

// ─── Task 54-d: agency STAFF analytics sub-nav definition + section registry ─
//
// The 4 doc-2 §30 tabs backed by the frozen 54-a contract (§3.1–3.4), rendered
// INSIDE the agency analytics shell when the viewer's session role is
// AGENCY_STAFF:
//   • my-overview (§31) + today-queue (§32) — fixed-TODAY operational views,
//     no period selector (payloads have `today`, no `resolved`);
//   • my-performance (§33) + my-services (§34) — accept the period selector.
//
// §29: staff analytics are permission-scoped — the backend live-checks
// `canViewAnalytics` on every request and answers
// 403 PERMISSION_DENIED:canViewAnalytics; sections render a friendly
// "no permission" panel for that case (StaffForbiddenPanel).

import {
  BarChart3,
  ListOrdered,
  Tags,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';

import { StaffMyOverviewSection } from './staff-section-overview';
import { StaffTodayQueueSection } from './staff-section-today-queue';
import { StaffPerformanceSection } from './staff-section-performance';
import { StaffServicesSection } from './staff-section-services';
import type { StaffSectionId } from './staff-types';

export interface StaffSectionNavItem {
  id: StaffSectionId;
  icon: LucideIcon;
  labelKey: string;
}

export const STAFF_SECTION_NAV: StaffSectionNavItem[] = [
  { id: 'my-overview', icon: BarChart3, labelKey: 'staffAnalytics.nav.overview' },
  { id: 'today-queue', icon: ListOrdered, labelKey: 'staffAnalytics.nav.todayQueue' },
  { id: 'my-performance', icon: TrendingUp, labelKey: 'staffAnalytics.nav.performance' },
  { id: 'my-services', icon: Tags, labelKey: 'staffAnalytics.nav.services' },
];

/** §31/§32 are fixed-TODAY views — the toolbar hides the period selector. */
export const STAFF_FIXED_TODAY_SECTIONS: ReadonlySet<StaffSectionId> = new Set([
  'my-overview',
  'today-queue',
]);

/** Props every staff section component accepts. */
export interface StaffSectionComponentProps {
  query: import('./use-staff-section-data').StaffSectionQuery;
}

export const STAFF_SECTION_COMPONENTS: Record<
  StaffSectionId,
  React.ComponentType<StaffSectionComponentProps>
> = {
  'my-overview': StaffMyOverviewSection,
  'today-queue': StaffTodayQueueSection,
  'my-performance': StaffPerformanceSection,
  'my-services': StaffServicesSection,
};

/** Title key per section (used by the shared toolbar header). */
export const STAFF_SECTION_TITLE_KEYS: Record<StaffSectionId, string> = {
  'my-overview': 'staffAnalytics.overview.title',
  'today-queue': 'staffAnalytics.queue.title',
  'my-performance': 'staffAnalytics.perf.title',
  'my-services': 'staffAnalytics.services.title',
};
