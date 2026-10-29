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
  // Task 86: dedicated full-screen customer search.
  'customer-search': '/customer/search',
  'customer-settings': '/customer/settings',
  'customer-agency-profile': '/customer/agency-profile',
  'customer-branch-profile': '/customer/branch-profile',
  'customer-sms-wallet': '/customer/sms-wallet',
  // Task 54-d: personal "My Analytics" module (doc-2 §38-44).
  'customer-analytics': '/customer/analytics',
  'customer-support': '/customer/support',
  // Chargily (EDAHABIA / CIB) hosted-checkout return view — role-agnostic and
  // self-guarding, so it deliberately takes no role prefix.
  'payment-result': '/payment/result',
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
  // typecheck). LIVE via payment-result.tsx (viewToUrl + getAllowedRolesForView);
  // the app-store hash map (#/…) is the one used for day-to-day URL sync.
  'agency-analytics': '/agency/analytics',
  'agency-support': '/agency/support',
  'agency-devices': '/agency/devices',
  'agency-fullscreen': '/agency/fullscreen',
  'agency-fullscreen-history': '/agency/fullscreen/history',
  'admin-dashboard': '/admin',
  'admin-transactions': '/admin/transactions',
  // Task 5-a: Agencies Management group. The role guard for all three is
  // inherited from the `admin-` prefix branch in getAllowedRolesForView
  // (SUPER_ADMIN only), same as every other admin view.
  'admin-agencies-management': '/admin/agencies-management',
  'admin-agencies': '/admin/agencies',
  'admin-services-management': '/admin/services-management',
  'admin-category-manager': '/admin/category-manager',
  'admin-category-language': '/admin/category-language',
  'admin-audit': '/admin/audit',
  'admin-users': '/admin/users',
  'admin-analytics': '/admin/analytics',
  'admin-settings': '/admin/settings',
  // Platform Settings split (Task 5): one URL per former section of the
  // admin-settings long-scroll page. Role guard is inherited from the
  // `admin-` prefix branch in getAllowedRolesForView (SUPER_ADMIN only).
  'admin-settings-vps': '/admin/settings/vps',
  'admin-settings-providers': '/admin/settings/providers',
  'admin-settings-maps': '/admin/settings/maps',
  'admin-settings-payments': '/admin/settings/payments',
  'admin-settings-security': '/admin/settings/security',
  'admin-settings-faq': '/admin/settings/faq',
  'admin-settings-config': '/admin/settings/config',
  'admin-settings-financial': '/admin/settings/financial',
  // r21-6 — unified Payment Center. Role guard inherited from the `admin-`
  // prefix branch in getAllowedRolesForView (SUPER_ADMIN only).
  'admin-payment-settings': '/admin/payment-settings',
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
  // Database Manager — SUPER_ADMIN PostgreSQL console. The role guard is
  // inherited from the `admin-` prefix branch in getAllowedRolesForView
  // (SUPER_ADMIN only), same as every other admin view.
  'admin-db': '/admin/db',
  // Task 2: Storage Manager — SUPER_ADMIN on-disk file store console.
  // Role guard is inherited from the `admin-` prefix branch in
  // getAllowedRolesForView (SUPER_ADMIN only), same as admin-db.
  'admin-storage': '/admin/storage',
  // logs-2 (0.6.19): Logs Manager — realtime log analysis console, same
  // SUPER_ADMIN guard as every other admin view (admin- prefix branch).
  'admin-logs-manager': '/admin/logs-manager',
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
