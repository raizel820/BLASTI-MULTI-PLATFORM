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
  'agency-dashboard': '/agency',
  'agency-settings': '/agency/settings',
  'agency-employees': '/agency/employees',
  'agency-profile': '/agency/profile',
  'agency-reviews': '/agency/reviews',
  'agency-subscription': '/agency/subscription',
  'agency-branches': '/agency/branches',
  'admin-dashboard': '/admin',
  'admin-transactions': '/admin/transactions',
  'admin-agencies': '/admin/agencies',
  'admin-audit': '/admin/audit',
  'admin-users': '/admin/users',
  'admin-analytics': '/admin/analytics',
  'admin-settings': '/admin/settings',
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
