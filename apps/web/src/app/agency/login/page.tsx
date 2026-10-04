'use client'

/**
 * Dedicated DESKTOP agency login page — addressable route.
 *
 * The desktop (Electron) app serves agencies only, so it gets its own
 * login page instead of the consumer web login. The Electron window
 * now ALWAYS opens on this route (main.js START_PATH = '/agency/login'):
 * the consumer marketing landing page is for the web app only.
 * This route also makes the agency console sign-in directly addressable
 * (deep links, diagnostics, dev preview).
 *
 * Agency-only: requests carry expectedRole 'AGENCY_OWNER' (accepted for
 * AGENCY_OWNER / AGENCY_STAFF / SUPER_ADMIN); CUSTOMER accounts are
 * refused with an explicit message. Account creation (no email/phone
 * verification) links to the register view, which is agency-only on
 * desktop as well.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/store/use-app-store'
import { DesktopAgencyLogin } from '@/components/auth/desktop-agency-login'
import { Toaster } from 'sonner'

export default function AgencyLoginPage() {
  const router = useRouter()
  const { isAuthenticated, user } = useAppStore()

  // Already signed in (persisted session)? Continue straight to the console —
  // the desktop app must never stop on the sign-in screen while a live session
  // exists. Same contract as /auth/login: the store rehydrates the saved user
  // and the SPA root renders the role's dashboard view.
  useEffect(() => {
    if (isAuthenticated && user) {
      router.replace('/')
    }
  }, [isAuthenticated, user, router])

  return (
    <>
      <DesktopAgencyLogin />
      <Toaster richColors position="top-center" />
    </>
  )
}
