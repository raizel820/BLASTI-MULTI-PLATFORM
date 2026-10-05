import type { ViewName } from '@/store/use-app-store';

/**
 * Mapping from Zustand view names to URL paths.
 * Used to sync the browser URL with the SPA navigation state.
 */
export const viewToUrl: Record<ViewName, string> = {
  'landing': '/',
  'login': '/auth/login',
  'register': '/auth/register',
  'customer-home': '/customer',
  'customer-queue': '/customer/queue',
  'customer-history': '/customer/history',
  'customer-notifications': '/customer/notifications',
  'customer-profile': '/customer/profile',
  'customer-favorites': '/customer/favorites',
  'customer-settings': '/customer/settings',
  'customer-agency-profile': '/customer/agency-profile',
  'customer-branch-profile': '/customer/branch-profile',
  'customer-sms-wallet': '/customer/sms-wallet',
  // Task 54-d: personal "My Analytics" module (doc-2 §38-44).
  'customer-analytics': '/customer/analytics',
  'customer-support': '/customer/support',
  'agency-dashboard': '/agency',
  'agency-settings': '/agency/settings',
  'agency-employees': '/agency/employees',
  'agency-profile': '/agency/profile',
  'agency-reviews': '/agency/reviews',
  'agency-subscription': '/agency/subscription',
  'agency-branches': '/agency/branches',
  // Task 42-e: dedicated Analytics & Statistics section. While wiring the new
  // view, this legacy map was also completed to be exhaustive over ViewName
  // (it previously missed 9 views and failed the Record<ViewName,string>
  // typecheck; it is not imported anywhere today, but kept type-safe).
  'agency-analytics': '/agency/analytics',
  'agency-support': '/agency/support',
  'agency-devices': '/agency/devices',
  'agency-fullscreen': '/agency/fullscreen',
  'agency-fullscreen-history': '/agency/fullscreen/history',
  'admin-dashboard': '/admin',
  'admin-transactions': '/admin/transactions',
  'admin-agencies': '/admin/agencies',
  'admin-audit': '/admin/audit',
  'admin-users': '/admin/users',
  'admin-analytics': '/admin/analytics',
  'admin-settings': '/admin/settings',
  'admin-tickets': '/admin/tickets',
  // Task 2-b: dedicated super-admin Maps & Location view. The role guard is
  // inherited from the `admin-` prefix branch in getAllowedRolesForView below
  // (same pattern as every other admin view → SUPER_ADMIN only).
  'admin-maps': '/admin/maps',
  'admin-subscription-plans': '/admin/subscription-plans',
  'admin-app-settings': '/admin/app-settings',
  'admin-hardware': '/admin/hardware',
  'admin-hardware-requests': '/admin/hardware-requests',
  'admin-enterprise-requests': '/admin/enterprise-requests',
  'kiosk': '/kiosk',
};

/**
 * Mapping from URL paths to Zustand view names.
 * Reverse of viewToUrl — used to determine the current view from the browser URL.
 */
export const urlToView: Record<string, ViewName> = Object.fromEntries(
  Object.entries(viewToUrl).map(([view, url]) => [url, view as ViewName])
) as Record<string, ViewName>;

/**
 * Get the URL path for a given view name.
 * Falls back to '/' if the view is not found.
 */
export function getUrlForView(view: ViewName): string {
  return viewToUrl[view] || '/';
}

/**
 * Get the view name for a given URL path.
 * Falls back to 'landing' if the URL is not recognized.
 */
export function getViewForUrl(pathname: string): ViewName {
  return urlToView[pathname] || 'landing';
}

/**
 * Determine which roles are allowed to access a given view.
 * Used by route pages for auth/role guards.
 */
export function getAllowedRolesForView(view: ViewName): Array<'CUSTOMER' | 'AGENCY_STAFF' | 'AGENCY_OWNER' | 'SUPER_ADMIN'> {
  if (view === 'landing' || view === 'login' || view === 'register') {
    return []; // No auth required
  }
  if (view.startsWith('customer-')) {
    return ['CUSTOMER'];
  }
  if (view.startsWith('agency-')) {
    return ['AGENCY_STAFF', 'AGENCY_OWNER'];
  }
  if (view.startsWith('admin-')) {
    return ['SUPER_ADMIN'];
  }
  return [];
}
