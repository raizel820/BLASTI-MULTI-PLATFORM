/**
 * Payment return-view resolution — the SINGLE source of truth for "where do
 * we send the payer once a checkout settles" (0.6.89).
 *
 * Consumers:
 *   - payment-result.tsx (the manual CTA + the new automatic return)
 *   - payment-settle-watcher.ts (background settlement → straight navigation)
 *
 * The rules mirror the historic payment-result CTA logic exactly:
 *   1. a pending checkout may carry a `returnView` — honored only when it is
 *      a real view this role is allowed to open (and never a loop back onto
 *      the result page itself);
 *   2. subscription / hardware payments → the agency subscription page (the
 *      activated status is visible there);
 *   3. SMS packs → the customer profile (the SMS wallet);
 *   4. otherwise the role's home (or landing when the principal is gone).
 */

import { viewToUrl, getAllowedRolesForView } from '@/lib/route-map';
import type { ViewName, UserRole } from '@/store/use-app-store';

/** A pending checkout may carry a `returnView` — honor it for the primary
 *  CTA only when it is a real view this role is allowed to open (and not a
 *  loop back onto the result page itself). */
export function isValidPaymentReturnView(
  view: string | undefined,
  role: UserRole | undefined,
): view is ViewName {
  if (!view || !(view in viewToUrl) || view === 'payment-result') return false;
  const allowed = getAllowedRolesForView(view as ViewName);
  return !role || allowed.length === 0 || allowed.includes(role);
}

/** Resolve the view a settled payment should land on. */
export function resolvePaymentReturnView(
  returnView: string | undefined,
  role: UserRole | undefined,
  type: string | undefined,
): ViewName {
  if (isValidPaymentReturnView(returnView, role)) return returnView;
  if (type === 'subscription' || type === 'hardware') return 'agency-subscription';
  if (type === 'sms') return 'customer-profile';
  if (role === 'AGENCY_OWNER' || role === 'AGENCY_STAFF') return 'agency-dashboard';
  if (role === 'SUPER_ADMIN') return 'admin-dashboard';
  if (role === 'CUSTOMER') return 'customer-home';
  return 'landing';
}
