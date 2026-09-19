'use client'

/**
 * Dedicated DESKTOP agency login page — addressable route.
 *
 * The desktop (Electron) app serves agencies only, so it gets its own
 * login page instead of the consumer web login. The Electron window
 * normally loads `/` (which auto-renders this page's component whenever
 * the platform is native and the login view is active); this route makes
 * the agency console sign-in directly addressable (deep links,
 * diagnostics, dev preview).
 *
 * Agency-only: requests carry expectedRole 'AGENCY_OWNER' (accepted for
 * AGENCY_OWNER / AGENCY_STAFF / SUPER_ADMIN); CUSTOMER accounts are
 * refused with an explicit message. Account creation (no email/phone
 * verification) links to the register view, which is agency-only on
 * desktop as well.
 */

import { DesktopAgencyLogin } from '@/components/auth/desktop-agency-login'
import { Toaster } from 'sonner'

export default function AgencyLoginPage() {
  return (
    <>
      <DesktopAgencyLogin />
      <Toaster richColors position="top-center" />
    </>
  )
}
