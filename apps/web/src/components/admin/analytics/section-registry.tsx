'use client';

// ─── Task 54-b: super-admin analytics sub-nav definition + section registry ──
//
// The 14 doc-2 §5.1 sections backed by the frozen 54-a contract. 'overview'
// renders the pre-existing dashboard (untouched behavior); the other 13 render
// the new section components against /api/admin/analytics/<section>.

import {
  BarChart3,
  Bell,
  Briefcase,
  Building2,
  ClipboardList,
  CreditCard,
  Crown,
  LayoutGrid,
  ListOrdered,
  MessageSquare,
  MonitorSmartphone,
  ShieldCheck,
  Users,
  UsersRound,
  Wifi,
  type LucideIcon,
} from 'lucide-react';

import { UsersSection } from './section-users';
import { AgenciesSection } from './section-agencies';
import { CategoriesSection } from './section-categories';
import { ReservationsSection } from './section-reservations';
import { QueuesSection } from './section-queues';
import { ServicesSection } from './section-services';
import { CustomersSection } from './section-customers';
import { SubscriptionsSection } from './section-subscriptions';
import { PaymentsSection } from './section-payments';
import { SmsSection, NotificationsSection } from './section-messaging';
import { DevicesSection } from './section-devices';
import { SecurityAuditSection } from './section-security-audit';
import { DataConsumptionSection } from './section-data-consumption';
import type { AdminSectionId } from './section-types';

export interface AdminSectionNavItem {
  id: AdminSectionId;
  icon: LucideIcon;
  labelKey: string;
}

export const ADMIN_SECTION_NAV: AdminSectionNavItem[] = [
  { id: 'overview', icon: BarChart3, labelKey: 'adminAnalytics.nav.overview' },
  { id: 'users', icon: Users, labelKey: 'adminAnalytics.nav.users' },
  { id: 'agencies', icon: Building2, labelKey: 'adminAnalytics.nav.agencies' },
  { id: 'categories', icon: LayoutGrid, labelKey: 'adminAnalytics.nav.categories' },
  { id: 'reservations', icon: ClipboardList, labelKey: 'adminAnalytics.nav.reservations' },
  { id: 'queues', icon: ListOrdered, labelKey: 'adminAnalytics.nav.queues' },
  { id: 'services', icon: Briefcase, labelKey: 'adminAnalytics.nav.services' },
  { id: 'customers', icon: UsersRound, labelKey: 'adminAnalytics.nav.customers' },
  { id: 'subscriptions', icon: Crown, labelKey: 'adminAnalytics.nav.subscriptions' },
  { id: 'payments', icon: CreditCard, labelKey: 'adminAnalytics.nav.payments' },
  { id: 'sms', icon: MessageSquare, labelKey: 'adminAnalytics.nav.sms' },
  { id: 'notifications', icon: Bell, labelKey: 'adminAnalytics.nav.notifications' },
  { id: 'devices', icon: MonitorSmartphone, labelKey: 'adminAnalytics.nav.devices' },
  // Task 55-c: data-consumption (doc-2 §14 + 55 contract) — after 'devices'.
  { id: 'data-consumption', icon: Wifi, labelKey: 'adminAnalytics.nav.dataConsumption' },
  { id: 'security-audit', icon: ShieldCheck, labelKey: 'adminAnalytics.nav.securityAudit' },
];

/** Props every section component accepts. */
export interface AdminSectionComponentProps {
  query: import('./use-admin-section-data').AdminSectionQuery;
  customHint: string;
}

export const ADMIN_SECTION_COMPONENTS: Record<
  Exclude<AdminSectionId, 'overview'>,
  React.ComponentType<AdminSectionComponentProps>
> = {
  users: UsersSection,
  agencies: AgenciesSection,
  categories: CategoriesSection,
  reservations: ReservationsSection,
  queues: QueuesSection,
  services: ServicesSection,
  customers: CustomersSection,
  subscriptions: SubscriptionsSection,
  payments: PaymentsSection,
  sms: SmsSection,
  notifications: NotificationsSection,
  devices: DevicesSection,
  'security-audit': SecurityAuditSection,
  'data-consumption': DataConsumptionSection,
};

/** Title key per section (used by the shared toolbar header). */
export const ADMIN_SECTION_TITLE_KEYS: Record<Exclude<AdminSectionId, 'overview'>, string> = {
  users: 'adminAnalytics.users.title',
  agencies: 'adminAnalytics.agencies.title',
  categories: 'adminAnalytics.categories.title',
  reservations: 'adminAnalytics.res.title',
  queues: 'adminAnalytics.queues.title',
  services: 'adminAnalytics.services.title',
  customers: 'adminAnalytics.customers.title',
  subscriptions: 'adminAnalytics.subs.title',
  payments: 'adminAnalytics.pay.title',
  sms: 'adminAnalytics.sms.title',
  notifications: 'adminAnalytics.notif.title',
  devices: 'adminAnalytics.devices.title',
  'security-audit': 'adminAnalytics.audit.title',
  'data-consumption': 'adminAnalytics.dataConsumption.title',
};
