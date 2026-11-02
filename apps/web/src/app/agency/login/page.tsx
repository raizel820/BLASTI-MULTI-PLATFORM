'use client'

/**
 * Agency console sign-in — addressable route.
 *
 * The Electron window ALWAYS opens on this route (main.js START_PATH =
 * '/agency/login'); the consumer marketing landing page is for the web app
 * only. This route also makes the agency console sign-in directly addressable
 * (deep links, diagnostics, dev preview).
 *
 * 0.6.48 — renders the UNIFIED login (components/auth/unified-login.tsx):
 *  - No expectedRole is sent anymore — the server auto-detects the account
 *    type from the credentials and enforces the desktop = agency-only matrix
 *    with a SECRECY-preserving generic error (correct credentials for an
 *    unsupported account type answer exactly like a wrong password).
 *  - The layout adapts to the REAL app shell: the Electron split-screen
 *    console here, the responsive web card in a browser.
 *  - Account creation links to the register view (agency-only on desktop).
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/store/use-app-store'
import { UnifiedLoginForm } from '@/components/auth/unified-login'
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
      {/* 0.6.48 — the unified login; inside the Electron shell it renders the
          desktop split-screen agency console automatically (real shell probe,
          never screen size), and the server auto-detects the account type. */}
      <UnifiedLoginForm />
      <Toaster richColors position="top-center" />
    </>
  )
}
