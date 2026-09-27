'use client';

// ─── Task 54-c: agency owner analytics sub-nav definition + section registry ─
//
// The 10 doc-2 §16 tabs backed by the frozen 54-a contract (§2.1–2.10).
// 'overview' renders the pre-existing dashboard (untouched behavior); the
// other 9 render the new section components against
// /api/agency/analytics/<section>.
//
// `ownerOnly: true` marks the §37 RESTRICTED sections (working-hours +
// payments): the backend answers 403 for AGENCY_STAFF callers, so the shell
// hides those tabs from non-owner viewers (session role / my-authority).

import {
  BarChart3,
  Building2,
  ClipboardList,
  Clock,
  CreditCard,
  ListOrdered,
  MessageSquareHeart,
  MonitorSmartphone,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { OwnerReservationsSection } from './section-reservations';
import { OwnerQueueSection } from './section-queue';
import { OwnerBranchesSection } from './section-branches';
import { OwnerStaffSection } from './section-staff';
import { OwnerCustomersSection } from './section-customers';
import { OwnerSatisfactionSection } from './section-satisfaction';
import { OwnerWorkingHoursSection } from './section-working-hours';
import { OwnerPaymentsSection } from './section-payments';
import { OwnerDevicesSection } from './section-devices';
import type { OwnerSectionId } from './section-types';

export interface OwnerSectionNavItem {
  id: OwnerSectionId;
  icon: LucideIcon;
  labelKey: string;
  /** §37 restricted — hidden from non-owner viewers (staff still 403 server-side). */
  ownerOnly?: boolean;
}

export const OWNER_SECTION_NAV: OwnerSectionNavItem[] = [
  { id: 'overview', icon: BarChart3, labelKey: 'ownerAnalytics.nav.overview' },
  { id: 'reservations', icon: ClipboardList, labelKey: 'ownerAnalytics.nav.reservations' },
  { id: 'queue', icon: ListOrdered, labelKey: 'ownerAnalytics.nav.queue' },
  { id: 'branches', icon: Building2, labelKey: 'ownerAnalytics.nav.branches' },
  { id: 'staff', icon: UserCog, labelKey: 'ownerAnalytics.nav.staff' },
  { id: 'customers', icon: Users, labelKey: 'ownerAnalytics.nav.customers' },
  { id: 'satisfaction', icon: MessageSquareHeart, labelKey: 'ownerAnalytics.nav.satisfaction' },
  { id: 'working-hours', icon: Clock, labelKey: 'ownerAnalytics.nav.workingHours', ownerOnly: true },
  { id: 'payments', icon: CreditCard, labelKey: 'ownerAnalytics.nav.payments', ownerOnly: true },
  { id: 'devices', icon: MonitorSmartphone, labelKey: 'ownerAnalytics.nav.devices' },
];

/** Props every section component accepts. */
export interface OwnerSectionComponentProps {
  query: import('./use-owner-section-data').OwnerSectionQuery;
  customHint: string;
}

export const OWNER_SECTION_COMPONENTS: Record<
  Exclude<OwnerSectionId, 'overview'>,
  React.ComponentType<OwnerSectionComponentProps>
> = {
  reservations: OwnerReservationsSection,
  queue: OwnerQueueSection,
  branches: OwnerBranchesSection,
  staff: OwnerStaffSection,
  customers: OwnerCustomersSection,
  satisfaction: OwnerSatisfactionSection,
  'working-hours': OwnerWorkingHoursSection,
  payments: OwnerPaymentsSection,
  devices: OwnerDevicesSection,
};

/** Title key per section (used by the shared toolbar header). */
export const OWNER_SECTION_TITLE_KEYS: Record<Exclude<OwnerSectionId, 'overview'>, string> = {
  reservations: 'ownerAnalytics.res.title',
  queue: 'ownerAnalytics.queue.title',
  branches: 'ownerAnalytics.branches.title',
  staff: 'ownerAnalytics.staff.title',
  customers: 'ownerAnalytics.customers.title',
  satisfaction: 'ownerAnalytics.satisfaction.title',
  'working-hours': 'ownerAnalytics.workingHours.title',
  payments: 'ownerAnalytics.pay.title',
  devices: 'ownerAnalytics.devices.title',
};
